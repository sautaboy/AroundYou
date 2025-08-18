require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const session = require('express-session');
const MongoStore = require('connect-mongo');
const path = require('path');
const http = require('http');
const socketio = require('socket.io');
const schedule = require('node-schedule');

const User = require('./models/User');
const Message = require('./models/Message');
const indexRoutes = require('./routes/chat');

const app = express();
const server = http.createServer(app);
const io = socketio(server);

// MongoDB
mongoose.connect(process.env.MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true });

// Middlewares
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.set('view engine', 'ejs');

// Sessions
const sessionMiddleware = session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    store: MongoStore.create({ mongoUrl: process.env.MONGO_URI })
});
app.use(sessionMiddleware);
io.use((socket, next)=>{ sessionMiddleware(socket.request, {}, next); });

// Routes
app.use('/', indexRoutes);

// Socket.io
const users = {}; // { socketId: { username, userId } }

io.on('connection', async socket=>{
    const session = socket.request.session;
    if(!session.userId) return;

    const username = session.username;
    users[socket.id] = { username, userId: session.userId };

    // Join nearby room
    socket.on('joinNearby', async ()=>{
        const currentUser = await User.findById(session.userId);
        const nearbyUsers = await User.find({
            location: {
                $near: {
                    $geometry: { type:'Point', coordinates: currentUser.location.coordinates },
                    $maxDistance: 100
                }
            }
        });
        const messages = await Message.find({ userId: { $in: nearbyUsers.map(u=>u._id) } }).sort({ createdAt:1 });
        socket.emit('pastMessages', messages);
    });

    // Receive message
    socket.on('message', async (msg, location)=>{
        if(!msg || !location) return;
        const currentUser = await User.findById(session.userId);
        const nearbyUsers = await User.find({
            location: {
                $near: {
                    $geometry: { type:'Point', coordinates: currentUser.location.coordinates },
                    $maxDistance: 100
                }
            }
        });
        if(nearbyUsers.length>0){
            const message = await Message.create({ userId:currentUser._id, username, msg });
            nearbyUsers.forEach(u=>{
                for(const [socketId, info] of Object.entries(users)){
                    if(info.userId.toString() === u._id.toString()){
                        io.to(socketId).emit('message', { user:username, msg });
                    }
                }
            });
        }
    });

    socket.on('disconnect', ()=>{ delete users[socket.id]; });
});

// Auto-delete messages at 10 PM every day
schedule.scheduleJob('0 22 * * *', async ()=>{ await Message.deleteMany({}); console.log('Messages cleared at 10 PM'); });

const PORT = process.env.PORT || 3000;
server.listen(PORT, ()=>console.log(`Server running on ${PORT}`));