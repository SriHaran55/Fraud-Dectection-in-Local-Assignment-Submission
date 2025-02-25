require("dotenv").config();
const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const multer = require("multer");
const path = require("path");
const nodemailer = require("nodemailer");

const app = express();
app.use(express.json());
app.use(cors());

// MongoDB Connection
mongoose.connect(process.env.MONGO_URI, {
    dbName: "fraud_detection",
    useNewUrlParser: true,
    useUnifiedTopology: true
})
.then(() => console.log("✅ MongoDB Connected"))
.catch(err => console.error("❌ MongoDB Connection Error:", err));

// Nodemailer Configuration
const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
    }
});

// User Schema
const UserSchema = new mongoose.Schema({
    email: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    role: { type: String, required: true, enum: ["student", "teacher", "admin"] },
    tempPassword: { type: String, default: null } // Temporary password for forgot password
});
const User = mongoose.model("User", UserSchema);

// Assignment Schema
const AssignmentSchema = new mongoose.Schema({
    email: { type: String, required: true },
    filename: { type: String, required: true },
    uploadTime: { type: Date, default: Date.now },
    status: { type: String, default: "submitted" }, // submitted, flagged, graded
    fraudScore: { type: Number, default: 0 },
    feedback: { type: String, default: "" },
    subject: { type: String, required: true } // Add subject field
});
const Assignment = mongoose.model("Assignment", AssignmentSchema);

// Notification Schema
const NotificationSchema = new mongoose.Schema({
    email: { type: String, required: true },
    message: { type: String, required: true },
    timestamp: { type: Date, default: Date.now }
});
const Notification = mongoose.model("Notification", NotificationSchema);

// Middleware to check role
const checkRole = (role) => (req, res, next) => {
    const userRole = req.headers.role; // Pass role in headers
    if (userRole !== role) return res.status(403).json({ message: "Access denied" });
    next();
};

// File Upload Configuration
const storage = multer.diskStorage({
    destination: "./uploads/",
    filename: (req, file, cb) => {
        cb(null, file.originalname); // Preserve the original filename
    }
});
const upload = multer({ storage });

// Routes
app.post("/register", async (req, res) => {
    const { email, password, role } = req.body;

    const existingUser = await User.findOne({ email });
    if (existingUser) return res.status(400).json({ message: "User already exists" });

    const newUser = new User({ email, password, role });
    await newUser.save();
    res.status(201).json({ message: "Registration successful" });
});

app.post("/login", async (req, res) => {
    const { email, password, role } = req.body;
    const user = await User.findOne({ email });

    if (!user) return res.status(400).json({ message: "User not found" });
    if (user.password !== password && user.tempPassword !== password) return res.status(400).json({ message: "Invalid credentials" });
    if (user.role !== role) return res.status(400).json({ message: "Invalid role" });

    res.json({ email: user.email, role: user.role });
});

app.post("/forgot-password", async (req, res) => {
    const { email } = req.body;
    const user = await User.findOne({ email });

    if (!user) return res.status(400).json({ message: "User not found" });

    // Generate a random temporary password
    const tempPassword = Math.random().toString(36).slice(-8);

    // Save the temporary password in the database
    user.tempPassword = tempPassword;
    await user.save();

    // Send the temporary password via email
    const mailOptions = {
        from: process.env.EMAIL_USER,
        to: email,
        subject: "Password Reset",
        text: `Your temporary password is: ${tempPassword}. Please use this to login and change your password.`
    };

    transporter.sendMail(mailOptions, (error, info) => {
        if (error) {
            console.error("Error sending email:", error);
            return res.status(500).json({ message: "Failed to send email", error: error.message });
        }
        console.log("Email sent:", info.response);
        res.json({ message: "Temporary password sent to your email" });
    });
});

app.post("/change-password", async (req, res) => {
    const { email, oldPassword, newPassword, confirmPassword } = req.body;
    const user = await User.findOne({ email });

    if (!user) return res.status(400).json({ message: "User not found" });
    if (newPassword !== confirmPassword) return res.status(400).json({ message: "New passwords do not match" });
    if (user.password !== oldPassword && user.tempPassword !== oldPassword) return res.status(400).json({ message: "Invalid old password" });

    // Update the password and clear the temporary password
    user.password = newPassword;
    user.tempPassword = null;
    await user.save();

    res.json({ message: "Password changed successfully" });
});

// Upload Assignment (Student and Teacher)
app.post("/upload", upload.single("file"), async (req, res) => {
    const { email, subject } = req.body;
    if (!req.file) return res.status(400).json({ message: "No file uploaded" });

    const newAssignment = new Assignment({
        email,
        filename: req.file.filename,
        subject // Include subject
    });

    await newAssignment.save();
    res.json({ message: "Assignment uploaded successfully" });
});

// Download Assignment
app.get("/download/:filename", (req, res) => {
    const filePath = path.join(__dirname, "uploads", req.params.filename);
    res.download(filePath, req.params.filename);
});

// Get Assignments for Dashboard (Student)
app.get("/assignments", async (req, res) => {
    const { email } = req.query;
    const assignments = await Assignment.find({ email }).sort({ uploadTime: -1 });
    res.json(assignments);
});

// Get All Assignments (Teacher)
app.get("/all-assignments", checkRole("teacher"), async (req, res) => {
    const assignments = await Assignment.find().sort({ uploadTime: -1 });
    res.json(assignments);
});

// Flag Assignment (Teacher)
app.post("/flag-assignment/:id", checkRole("teacher"), async (req, res) => {
    const { id } = req.params;
    const { fraudScore, feedback } = req.body;

    const assignment = await Assignment.findByIdAndUpdate(id, { status: "flagged", fraudScore, feedback }, { new: true });

    // Notify student
    const notification = new Notification({
        email: assignment.email,
        message: `Your assignment "${assignment.filename}" has been flagged. Feedback: ${feedback}`
    });
    await notification.save();

    res.json({ message: "Assignment flagged", assignment });
});

// Get Notifications (All Roles)
app.get("/notifications", async (req, res) => {
    const { email } = req.query;
    const notifications = await Notification.find({ email }).sort({ timestamp: -1 });
    res.json(notifications);
});

// Upload Text Assignment (Teacher)
app.post("/upload-text", async (req, res) => {
    const { email, subject, text } = req.body;

    const newAssignment = new Assignment({
        email,
        text,
        subject
    });

    await newAssignment.save();
    res.json({ message: "Text assignment posted successfully" });
});

// Start Server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));