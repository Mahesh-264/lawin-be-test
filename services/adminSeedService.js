const User = require('../models/User');

const seedAdminUser = async () => {
  try {
    const adminEmail = 'admin@verdits.com';
    let admin = await User.findOne({
      $or: [{ email: adminEmail }, { role: 'admin' }],
    }).select('+password');

    if (!admin) {
      console.log('🌱 Seeding initial admin account...');
      admin = new User({
        firstName: 'System',
        lastName: 'Admin',
        email: adminEmail,
        phone: '9999999999',
        password: 'Admin@123',
        role: 'admin',
        accountStatus: 'active',
        verified: true,
        emailVerified: true,
        phoneVerified: true,
      });
      await admin.save();
      console.log('✅ Admin user created: admin@verdits.com / Admin@123');
    } else {
      admin.email = adminEmail;
      admin.role = 'admin';
      admin.accountStatus = 'active';
      admin.verified = true;
      admin.emailVerified = true;
      admin.phoneVerified = true;

      const passwordMatches = admin.password ? await admin.matchPassword('Admin@123') : false;
      if (!passwordMatches) {
        console.log('🔐 Resetting admin password to Admin@123...');
        admin.password = 'Admin@123';
        admin.$locals = admin.$locals || {};
        admin.$locals.passwordIsHashed = false;
        await admin.save();
        console.log('✅ Admin password updated to Admin@123');
      }
    }
  } catch (error) {
    console.error('❌ Error seeding admin user:', error.message);
  }
};

module.exports = seedAdminUser;
