const test = require('node:test');
const assert = require('node:assert/strict');
const { getUploadDetails, getFileExtension } = require('../controllers/chatController');

test('chat uploads classify JPG and PNG files as Cloudinary images', () => {
  for (const mimetype of ['image/jpeg', 'image/png']) {
    assert.deepEqual(getUploadDetails({ mimetype }), {
      messageType: 'image',
      resourceType: 'image',
    });
  }
});

test('chat uploads classify PDFs as raw Cloudinary documents', () => {
  assert.deepEqual(getUploadDetails({ mimetype: 'application/pdf' }), {
    messageType: 'document',
    resourceType: 'raw',
  });
});

test('chat upload temp files retain document and image extensions', () => {
  assert.equal(getFileExtension({ originalname: 'evidence.pdf', mimetype: 'application/pdf' }), '.pdf');
  assert.equal(getFileExtension({ originalname: 'photo.png', mimetype: 'image/png' }), '.png');
  assert.equal(getFileExtension({ originalname: 'document', mimetype: 'application/pdf' }), '.pdf');
});
