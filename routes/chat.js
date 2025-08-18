const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const User = require('../models/User');
const Message = require('../models/Message');

// Helper: check chat open hours (6 AM to 2:59 AM next day)
function isChatOpen() {
    const hour = new Date().getHours();
    // Open from 6:00 (6) to 2:59 (2) next day
    return (hour >= 6 && hour < 24) || (hour >= 0 && hour < 3);
}

// Helper: delete all messages (called after chat closes)
async function deleteAllMessages() {
    await Message.deleteMany({});
}

// Schedule message deletion at 3:00 AM server time
function scheduleMessageDeletion() {
    const now = new Date();
    const next3am = new Date(now);
    next3am.setHours(3, 0, 0, 0);
    if (now >= next3am) {
        // If past 3am today, schedule for tomorrow
        next3am.setDate(next3am.getDate() + 1);
    }
    const msUntil3am = next3am - now;
    setTimeout(async () => {
        await deleteAllMessages();
        scheduleMessageDeletion(); // Reschedule for next day
    }, msUntil3am);
}
scheduleMessageDeletion();

// Index page
router.get('/', (req, res) => res.render('index'));

// Signup
router.post('/signup', async (req, res) => {
    const { username, email, password, gender } = req.body;
    if (!username || !email || !password || !gender) return res.send('All fields required');
    if (password.length < 8) return res.send('Password must be at least 8 characters');

    const existing = await User.findOne({ $or: [{ email }, { username }] });
    if (existing) return res.send('Email or username exists');

    const hashed = await bcrypt.hash(password, 10);
    const user = await User.create({ username, email, password: hashed, gender });
    req.session.userId = user._id;
    req.session.username = user.username;
    res.redirect('/chat');
});

// Login
router.post('/login', async (req, res) => {
    const { email, password } = req.body;
    const user = await User.findOne({ email });
    console.log(user); // check if user exists
    if (!user) return res.send('Invalid email');
    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.send('Invalid password');

    req.session.userId = user._id;
    req.session.username = user.username;
    console.log('Session ID:', req.session.userId); // confirm session is set
    res.redirect('/chat');
});

// Logout
router.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/');
});

// Update user location
router.post('/update-location', async (req, res) => {
    if (!req.session.userId) return res.status(401).send('Unauthorized');
    const { latitude, longitude } = req.body;
    await User.findByIdAndUpdate(req.session.userId, {
        location: { type: 'Point', coordinates: [longitude, latitude] }
    });
    res.sendStatus(200);
});

// Chat page
router.get('/chat', async (req, res) => {
    console.log('Session:', req.session.userId);
    if (!req.session.userId) return res.redirect('/');
    const currentUser = await User.findById(req.session.userId);
    res.render('chat', { currentUser, chatOpen: isChatOpen() });
});

// Fetch past nearby messages (optional)
router.get('/chat/message/all', async (req, res) => {
    if (!req.session.userId) return res.status(401).send('Unauthorized');
    const currentUser = await User.findById(req.session.userId);
    const nearbyUsers = await User.find({
        location: {
            $near: {
                $geometry: { type: 'Point', coordinates: currentUser.location.coordinates },
                $maxDistance: 100
            }
        }
    });
    const messages = await Message.find({ userId: { $in: nearbyUsers.map(u => u._id) } })
                                  .sort({ createdAt: 1 });
    res.json(messages);
});

module.exports = router;


