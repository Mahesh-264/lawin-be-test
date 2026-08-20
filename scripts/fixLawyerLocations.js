require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../models/User');
const {
  hasManualLocationInput,
  resolveLawyerAddress,
} = require('../services/locationResolutionService');

async function fixLocations() {
  try {
    await mongoose.connect(process.env.MONGO_URI);

    const lawyers = await User.find({ role: 'lawyer' });
    let updated = 0;
    let skipped = 0;
    let failed = 0;

    for (const lawyer of lawyers) {
      const currentAddress = lawyer.address?.toObject ? lawyer.address.toObject() : (lawyer.address || {});

      if (!hasManualLocationInput(currentAddress)) {
        skipped += 1;
        continue;
      }

      try {
        const resolvedAddress = await resolveLawyerAddress(currentAddress, {
          requireCoordinates: false,
        });

        const nextAddress = JSON.stringify(resolvedAddress.address);
        const nextLocation = JSON.stringify(resolvedAddress.location || null);
        const currentStoredAddress = JSON.stringify(currentAddress || {});
        const currentStoredLocation = JSON.stringify(lawyer.location || null);

        if (nextAddress === currentStoredAddress && nextLocation === currentStoredLocation) {
          skipped += 1;
          continue;
        }

        lawyer.address = resolvedAddress.address;
        lawyer.location = resolvedAddress.location;
        await lawyer.save();
        updated += 1;
      } catch (error) {
        failed += 1;
        console.error(`Failed to repair lawyer ${lawyer._id}: ${error.message}`);
      }
    }

    console.log(`Updated ${updated} lawyers`);
    console.log(`Skipped ${skipped} lawyers`);
    console.log(`Failed ${failed} lawyers`);
    process.exit(0);
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
}

fixLocations();
