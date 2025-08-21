const express = require("express");
const router = express.Router();
const bcrypt = require("bcryptjs");
const nodemailer = require("nodemailer");
const User = require("../models/User");
const Message = require("../models/Message");

// Store OTPs temporarily (use Redis/DB in production)
let otpStore = {};

// Nodemailer transporter (Brevo)
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.EMAIL_USER, // your Gmail address
    pass: process.env.EMAIL_PASS, // your Gmail app password
  },
});

/* ================== SIGNUP with OTP ================== */

// Step 1: Send OTP
router.post("/send-otp", async (req, res) => {
  try {
    const { username, email, password, gender } = req.body;

    // Basic field check
    if (!username || !email || !password || !gender) {
      return res.json({ success: false, message: "All fields are required" });
    }

    // Username validation
    const usernameRegex = /^[A-Za-z][A-Za-z0-9_]{1,}$/;
    if (!usernameRegex.test(username)) {
      return res.json({
        success: false,
        message:
          "Username must be one word, start with a letter, only letters/numbers, min 2 chars",
      });
    }

    // Email validation
    const emailRegex = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
    if (!emailRegex.test(email)) {
      return res.json({
        success: false,
        message: "Invalid email format",
      });
    }

    // Password validation
    const passwordRegex =
      /^(?=.*[A-Za-z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]{8,}$/;
    if (!passwordRegex.test(password)) {
      return res.json({
        success: false,
        message:
          "Password must include at least 8 chars, one letter, one number, one special char",
      });
    }

    // Check if user exists
    const existing = await User.findOne({ $or: [{ email }, { username }] });
    if (existing) {
      return res.json({
        success: false,
        message: "Email or username already exists",
      });
    }

    // Generate OTP
    const otp = Math.floor(100000 + Math.random() * 900000).toString();

    // Store temporarily
    otpStore[email] = {
      otp,
      username,
      email,
      password: await bcrypt.hash(password, 10),
      gender,
      expires: Date.now() + 5 * 60 * 1000, // 5 mins
    };

    // Send OTP via Brevo SMTP
    await transporter.sendMail({
      from: `"Location Chat App" <${process.env.BREVO_SENDER}>`, // ✅ Verified sender
      to: email,
      subject: "Verify your Email - OTP Code",
      html: `<p>Your OTP is: <b>${otp}</b></p>`,
    });

    return res.json({
      success: true,
      message: "OTP sent to your email. Please verify.",
    });
  } catch (err) {
    console.error("Error sending OTP:", err);
    return res.json({ success: false, message: "Error sending OTP" });
  }
});

// Step 2: Verify OTP & create account
router.post("/verify-otp", async (req, res) => {
  try {
    const { email, otp } = req.body;
    const record = otpStore[email];

    if (!record) {
      return res.json({ success: false, message: "No OTP request found" });
    }
    if (Date.now() > record.expires) {
      return res.json({ success: false, message: "OTP expired" });
    }
    if (record.otp !== otp) {
      return res.json({ success: false, message: "Invalid OTP" });
    }

    // Create user
    await User.create({
      username: record.username,
      email: record.email,
      password: record.password,
      gender: record.gender,
    });

    // Clean up
    delete otpStore[email];

    return res.json({ success: true, message: "Signup successful!" });
  } catch (err) {
    console.error("Error verifying OTP:", err);
    return res.json({ success: false, message: "Error verifying OTP" });
  }
});

/* ================== LOGIN ================== */
router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.json({ success: false, message: "All fields are required" });
    }

    const user = await User.findOne({ email });
    if (!user) {
      return res.json({ success: false, message: "Invalid email" });
    }

    const match = await bcrypt.compare(password, user.password);
    if (!match) {
      return res.json({ success: false, message: "Invalid password" });
    }

    req.session.userId = user._id;
    req.session.username = user.username;

    return res.json({ success: true, message: "Login successful" });
  } catch (err) {
    console.error("Login error:", err);
    return res.json({ success: false, message: "Login error, try again" });
  }
});

router.get("/logout", (req, res) => {
  req.session.destroy();
  res.redirect("/");
});

/* ================== Chat Utils ================== */

let cleanupInterval = null;

// Define open windows (24h format) → [startHour, endHour]
const openWindows = [
  [6, 9], // 6 AM - 9 AM
  [11, 15], // 11 AM - 3 PM
  [17, 23], // 5 PM - 11 PM
];

function isChatOpen() {
  const hour = new Date().getHours();
  return openWindows.some(([start, end]) => hour >= start && hour < end);
}

// Delete all messages
async function deleteAllMessages() {
  try {
    const result = await Message.deleteMany({});
    console.log(
      `[${new Date().toLocaleString()}] Deleted ${result.deletedCount} messages`
    );
  } catch (err) {
    console.error("Error deleting messages:", err);
  }
}

// Start continuous cleanup when chat is closed
function startCleanupInterval() {
  if (!cleanupInterval) {
    cleanupInterval = setInterval(deleteAllMessages, 60 * 1000); // every 1 min
    console.log("✅ Cleanup interval started (chat closed).");
  }
}

// Stop continuous cleanup when chat is open
function stopCleanupInterval() {
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
    cleanupInterval = null;
    console.log("🛑 Cleanup interval stopped (chat open).");
  }
}

// Scheduler to switch modes at open/close times
function scheduleMessageDeletion() {
  const now = new Date();
  const nextEvent = getNextChatEvent();
  const msUntilRun = nextEvent.time - now;

  // Start or stop cleanup depending on chat state
  if (isChatOpen()) {
    stopCleanupInterval();
  } else {
    startCleanupInterval();
  }

  setTimeout(async () => {
    if (nextEvent.type === "open") {
      stopCleanupInterval();
    } else {
      await deleteAllMessages(); // ✅ works now
      startCleanupInterval();
    }
    scheduleMessageDeletion(); // reschedule
  }, msUntilRun);

  console.log(
    `⏳ Next chat ${
      nextEvent.type
    } scheduled for: ${nextEvent.time.toLocaleString()}`
  );
}

// Determine next chat open/close event
function getNextChatEvent() {
  const now = new Date();
  const hour = now.getHours();

  const windows = [
    [6, 9], // 6-9 AM
    [11, 15], // 11 AM - 3 PM
    [17, 23], // 5-11 PM
  ];

  for (const [start, end] of windows) {
    if (hour < start) {
      const next = new Date(now);
      next.setHours(start, 0, 0, 0);
      return { type: "open", time: next };
    }
    if (hour >= start && hour < end) {
      const next = new Date(now);
      next.setHours(end, 0, 0, 0);
      return { type: "close", time: next };
    }
  }

  // past last window → next open tomorrow 6 AM
  const next = new Date(now);
  next.setDate(next.getDate() + 1);
  next.setHours(6, 0, 0, 0);
  return { type: "open", time: next };
}

// Start scheduler
scheduleMessageDeletion();

/* ================== ROUTES ================== */

router.get("/", (req, res) => res.render("index"));

router.post("/update-location", async (req, res) => {
  if (!req.session.userId) return res.status(401).send("Unauthorized");
  const { latitude, longitude } = req.body;
  await User.findByIdAndUpdate(req.session.userId, {
    location: { type: "Point", coordinates: [longitude, latitude] },
  });
  res.sendStatus(200);
});

function getNextChatEvent() {
  const now = new Date();
  const hour = now.getHours();

  // Define chat windows
  const windows = [
    [6, 9], // 6-9 AM
    [11, 15], // 11 AM-3 PM
    [17, 23], // 5-11 PM
  ];

  for (const [start, end] of windows) {
    if (hour < start) {
      // Next open
      const next = new Date(now);
      next.setHours(start, 0, 0, 0);
      return { type: "open", time: next };
    }
    if (hour >= start && hour < end) {
      // Currently open → next close
      const next = new Date(now);
      next.setHours(end, 0, 0, 0);
      return { type: "close", time: next };
    }
  }

  // If past last window, next open is tomorrow 6 AM
  const next = new Date(now);
  next.setDate(next.getDate() + 1);
  next.setHours(6, 0, 0, 0);
  return { type: "open", time: next };
}

router.get("/chat", async (req, res) => {
  if (!req.session.userId) return res.redirect("/");
  const currentUser = await User.findById(req.session.userId);
  const nextEvent = getNextChatEvent();
  res.render("chat", {
    currentUser,
    chatOpen: isChatOpen(),
    nextChatTime: nextEvent.time.getTime(), // timestamp for frontend
    nextChatType: nextEvent.type,
  });
});

router.get("/chat/message/all", async (req, res) => {
  if (!req.session.userId) return res.status(401).send("Unauthorized");
  const currentUser = await User.findById(req.session.userId);
  const nearbyUsers = await User.find({
    location: {
      $near: {
        $geometry: {
          type: "Point",
          coordinates: currentUser.location.coordinates,
        },
        $maxDistance: 500, // 500m
      },
    },
  });
  const messages = await Message.find({
    userId: { $in: nearbyUsers.map((u) => u._id) },
  }).sort({ createdAt: 1 });
  res.json(messages);
});

module.exports = router;
