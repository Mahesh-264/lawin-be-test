const jwt = require('jsonwebtoken');
const User = require('../models/User');

exports.protect = async (req, res, next) => {
  try {
    let token = req.headers.authorization?.startsWith('Bearer') ? req.headers.authorization.split(' ')[1] : null;
    console.log("🛡️ Authenticating request...");
    if (!token) return res.status(401).json({ message: "Not authorized" });

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = await User.findById(decoded.id);
    if (!req.user) return res.status(401).json({ message: "User not found" });

    // Repair legacy role values such as "Lawyer" so all role guards and
    // controller queries consistently use the current lowercase enum values.
    const normalizedRole = String(req.user.role || '').trim().toLowerCase();
    if (['user', 'lawyer', 'student', 'admin'].includes(normalizedRole) && normalizedRole !== req.user.role) {
      await User.updateOne({ _id: req.user._id }, { $set: { role: normalizedRole } });
      req.user.role = normalizedRole;
    }

    if (req.user.accountStatus && req.user.accountStatus !== 'active') {
      return res.status(403).json({ message: 'Account is not active' });
    }
    next();
  } catch (error) { 
    console.warn("⚠️ Auth Failed:", error.message);
    res.status(401).json({ message: "Token expired" }); 
  }
};

exports.authorize = (...roles) => {
  return (req, res, next) => {
    console.log(`👮 Role Check: User[${req.user.role}] vs Allowed[${roles}]`);
    const userRole = String(req.user?.role || '').trim().toLowerCase();
    const allowedRoles = roles.map((role) => String(role).trim().toLowerCase());
    if (!allowedRoles.includes(userRole)) return res.status(403).json({ message: "Forbidden" });

    // Preserve support for legacy accounts whose role was saved with different
    // capitalization, while retaining the same role-based access control.
    req.user.role = userRole;
    next();
  };
};
