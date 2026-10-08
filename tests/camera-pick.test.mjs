import test from 'node:test'
import assert from 'node:assert/strict'
import { isPhoneLinkLabel, isBuiltinWebcamLabel, pickCamera, cameraOptionLabel, NO_PC_CAMERA } from '../src/lib/camera-pick.mjs'

test('auto uses the laptop webcam, not Phone Link', () => {
  assert.equal(isPhoneLinkLabel('Phone Link Camera'), true)
  assert.equal(isBuiltinWebcamLabel('Integrated Camera'), true)
  const devices = [
    { kind: 'videoinput', deviceId: 'phone', label: 'Phone Link' },
    { kind: 'videoinput', deviceId: 'laptop', label: 'Integrated Camera' },
  ]
  const auto = pickCamera(devices, 'auto')
  assert.equal(auto.device.deviceId, 'laptop')
  assert.equal(auto.reason, 'laptop')
  const chosen = pickCamera(devices, 'phone')
  assert.equal(chosen.device.deviceId, 'phone')
  assert.match(cameraOptionLabel(devices[0]), /Phone Link/)
})

test('auto skips Phone Link when it is the only listed camera', () => {
  const onlyPhone = [{ kind: 'videoinput', deviceId: 'phone', label: 'Your Phone' }]
  const miss = pickCamera(onlyPhone, 'auto')
  assert.equal(miss.device, null)
  assert.equal(miss.reason, 'missing-pc')
  assert.equal(miss.help, NO_PC_CAMERA)
})

test('auto prefers any non-Phone-Link camera over continuity camera', () => {
  const devices = [
    { kind: 'videoinput', deviceId: 'phone', label: 'Continuity Camera' },
    { kind: 'videoinput', deviceId: 'usb', label: 'USB Camera' },
  ]
  const auto = pickCamera(devices, 'auto')
  assert.equal(auto.device.deviceId, 'usb')
  assert.equal(auto.reason, 'pc')
})
