require("dotenv").config({ override: true });
const express = require("express");
const mongoose = require("mongoose");
const session = require("express-session");
const MongoStore = require("connect-mongo");
const path = require("path");
const http = require("http");
const socketio = require("socket.io");
const schedule = require("node-schedule");

const User = require("./models/User");
const Message = require("./models/Message");
const indexRoutes = require("./routes/chat");

const app = express();
const server = http.createServer(app);
const io = socketio(server);

// Connect to MongoDB
mongoose
  .connect(process.env.MONGO_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
  })
  .then(() => console.log("MongoDB connected"))
  .catch((err) => console.error("MongoDB connection error:", err));
  
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));
app.set("view engine", "ejs");

// Sessions
const sessionMiddleware = session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  store: MongoStore.create({ mongoUrl: process.env.MONGO_URI }),
});
app.use(sessionMiddleware);
io.use((socket, next) => {
  sessionMiddleware(socket.request, {}, next);
});

// Routes
app.use("/", indexRoutes);
// Socket.io
const users = {}; // { socketId: { username, userId, coords } }

io.on("connection", async (socket) => {
  const session = socket.request.session;
  if (!session.userId) return;

  const username = session.username;
  users[socket.id] = { username, userId: session.userId, coords: null };

  // Client sends location updates
  socket.on("updateLocation", async (coords) => {
    users[socket.id].coords = coords;

    // Find nearby users for this socket
    const currentUser = await User.findById(session.userId);
    currentUser.location = {
      type: "Point",
      coordinates: [coords.lng, coords.lat],
    };
    await currentUser.save();

    const nearbyUsers = await User.find({
      location: {
        $near: {
          $geometry: currentUser.location,
          $maxDistance: 3000, // 3km
        },
      },
    });

    // Tell client who is nearby (for UI updates)
    socket.emit(
      "nearbyUpdate",
      nearbyUsers.map((u) => ({ id: u._id, username: u.username }))
    );
  });

  // When user sends a message
  socket.on("message", async (msg) => {
    if (!msg) return;

    const sender = await User.findById(session.userId);
    if (!sender) return;

    const nearbyUsers = await User.find({
      location: {
        $near: {
          $geometry: sender.location,
          $maxDistance: 3000, // 3km
        },
      },
    });

    if (nearbyUsers.length > 0) {
      const message = await Message.create({
        userId: sender._id,
        username,
        msg,
      });

      // Deliver only to sockets belonging to nearby users
      nearbyUsers.forEach((u) => {
        for (const [socketId, info] of Object.entries(users)) {
          if (info.userId.toString() === u._id.toString()) {
            io.to(socketId).emit("message", {
              user: username,
              msg,
              timestamp: new Date(),
            });
          }
        }
      });
    }
  });

  // Disconnect
  socket.on("disconnect", () => {
    delete users[socket.id];
  });
});

// Auto-delete messages at 9 AM, 3 PM, 11 PM
const cleanupTimes = ["0 9 * * *", "0 15 * * *", "0 23 * * *"];
cleanupTimes.forEach((rule) => {
  schedule.scheduleJob(rule, async () => {
    await Message.deleteMany({});
    console.log(`[${new Date().toLocaleString()}] Messages cleared`);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on ${PORT}`));
