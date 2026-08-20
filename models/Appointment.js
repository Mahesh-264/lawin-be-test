const mongoose = require('mongoose');

const appointmentSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  lawyerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  status: {
    type: String,
    enum: ['pending', 'accepted', 'rejected', 'cancelled'],
    default: 'pending'
  }
}, { timestamps: true });

appointmentSchema.index({ userId: 1, lawyerId: 1 }, { unique: true });

module.exports = mongoose.model('Appointment', appointmentSchema);
