const express = require('express');
const mongoose = require('mongoose');
const Appointment = require('../models/Appointment');
const User = require('../models/User');
const { protect } = require('../middleware/authMiddleware');
const { createNotification, getDisplayName } = require('../services/notificationService');

const router = express.Router();
router.use(protect);

const populateAppointment = [
  {
    path: 'userId',
    select: 'firstName lastName profileImage phone'
  },
  {
    path: 'lawyerId',
    select: 'firstName lastName profileImage phone lawyerProfile.specialization'
  }
];

const normalizeStatus = (status) => {
  if (!status) return undefined;

  const formattedStatus = String(status).toLowerCase();
  if (['pending', 'accepted', 'rejected'].includes(formattedStatus)) {
    return formattedStatus;
  }

  return undefined;
};

// Create request
router.post('/', async (req, res) => {
  const { lawyerId } = req.body;
  const requesterId = req.user?._id;

  if (req.user.role !== 'user') {
    return res.status(403).json({ message: 'You can only create appointments for your own account' });
  }

  if (!lawyerId || !mongoose.isValidObjectId(lawyerId)) {
    return res.status(400).json({ message: 'A valid lawyer is required' });
  }

  try {
    // Older accounts may have been stored with an uppercase role. The lawyer
    // discovery flow already supports both values, so appointment requests
    // must resolve the same lawyers.
    const lawyer = await User.findOne({
      _id: lawyerId,
      role: { $in: ['lawyer', 'LAWYER'] },
    }).select('_id');
    if (!lawyer) return res.status(404).json({ message: 'Lawyer not found' });

    let appointment = await Appointment.findOne({ userId: requesterId, lawyerId });
    let shouldNotifyLawyer = false;

    if (appointment?.status === 'cancelled') {
      appointment.status = 'pending';
      await appointment.save();
      shouldNotifyLawyer = true;
    } else if (!appointment) {
      try {
        appointment = await Appointment.create({ userId: requesterId, lawyerId });
        shouldNotifyLawyer = true;
      } catch (error) {
        // Two quick clicks can race the unique index. Return the request that
        // won rather than reporting a false failure to the client.
        if (error?.code !== 11000) throw error;
        appointment = await Appointment.findOne({ userId: requesterId, lawyerId });
      }
    }

    const populatedAppointment = await Appointment.findById(appointment._id).populate(populateAppointment);

    if (shouldNotifyLawyer) {
      await createNotification({
        recipient: lawyerId,
        actor: requesterId,
        type: 'appointment_request',
        title: 'New appointment request',
        message: `${getDisplayName(req.user, 'A user')} requested an appointment with you.`,
        link: `/lawyer-dash?section=appointments&appointmentId=${appointment._id}`,
        metadata: { appointmentId: appointment._id, requesterId },
        io: req.app.get('socketio'),
      });
    }

    res.status(shouldNotifyLawyer ? 201 : 200).json(populatedAppointment);
  } catch (error) {
    console.error('Error creating appointment request:', error);
    res.status(500).json({ message: 'Unable to create appointment request' });
  }
});

// Get the current user's accepted lawyer connections.
// This route must come before `/:lawyerId` so "user/mine" is not treated as
// a lawyer id.
router.get('/user/mine', async (req, res) => {
  if (req.user.role !== 'user') {
    return res.status(403).json({ message: 'Only users can view their lawyer connections' });
  }

  try {
    const data = await Appointment.find({
      userId: req.user._id,
      status: 'accepted',
    })
      .populate(populateAppointment)
      .sort({ updatedAt: -1 });

    res.json(data);
  } catch (error) {
    console.error('Error loading user lawyer connections:', error);
    res.status(500).json({ message: 'Unable to load your connected lawyers' });
  }
});

// Get lawyer appointments
router.get('/:lawyerId', async (req, res) => {
  const isLawyerOwner = req.user.role === 'lawyer' && String(req.user._id) === String(req.params.lawyerId);
  const isClient = req.user.role === 'user';

  if (!isLawyerOwner && !isClient) {
    return res.status(403).json({ message: 'Forbidden' });
  }

  const query = { lawyerId: req.params.lawyerId };
  if (isClient) {
    query.userId = req.user._id;
  }

  const data = await Appointment.find(query)
    .populate(populateAppointment)
    .sort({ createdAt: -1 });

  res.json(data);
});

// Accept / Reject
router.put('/:id', async (req, res) => {
  if (req.user.role !== 'lawyer') {
    return res.status(403).json({ message: 'Only lawyers can update appointment status' });
  }

  const status = normalizeStatus(req.body.status);

  if (!status) {
    return res.status(400).json({ message: 'Invalid appointment status' });
  }

  const appointment = await Appointment.findById(req.params.id);
  if (!appointment) {
    return res.status(404).json({ message: 'Appointment not found' });
  }

  if (String(appointment.lawyerId) !== String(req.user._id)) {
    return res.status(403).json({ message: 'You can only update your own appointments' });
  }

  if (appointment.status !== 'pending') {
    return res.status(409).json({ message: 'Only pending appointments can be updated' });
  }

  const updated = await Appointment.findByIdAndUpdate(
    req.params.id,
    { status },
    { new: true }
  ).populate(populateAppointment);

  const lawyer = updated.lawyerId;
  const notificationType = status === 'accepted' ? 'appointment_accepted' : 'appointment_rejected';
  const notificationTitle = status === 'accepted'
    ? 'Lawyer accepted your request'
    : 'Lawyer rejected your request';

  await createNotification({
    recipient: updated.userId?._id || updated.userId,
    actor: updated.lawyerId?._id || updated.lawyerId,
    type: notificationType,
    title: notificationTitle,
    message: `${getDisplayName(lawyer, 'Your lawyer')} ${status} your appointment request.`,
    link: `/lawyer-profile/${updated.lawyerId?._id || updated.lawyerId}`,
    metadata: { appointmentId: updated._id, status, lawyerId: updated.lawyerId?._id || updated.lawyerId },
    io: req.app.get('socketio'),
  });

  res.json(updated);
});

// Clients may only cancel their own pending request. Keeping the record makes
// history and notification state auditable while preventing status tampering.
router.patch('/:id/cancel', async (req, res) => {
  if (req.user.role !== 'user') {
    return res.status(403).json({ message: 'Only users can cancel appointment requests' });
  }

  const updated = await Appointment.findOneAndUpdate(
    { _id: req.params.id, userId: req.user._id, status: 'pending' },
    { status: 'cancelled' },
    { new: true }
  ).populate(populateAppointment);

  if (!updated) {
    return res.status(404).json({ message: 'Pending appointment not found' });
  }

  res.json(updated);
});

module.exports = router;
