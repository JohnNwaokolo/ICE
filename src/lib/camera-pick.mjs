/** Prefer the PC / laptop webcam. Do not auto-select Phone Link. */

export const PHONE_LINK_PATTERN = /phone\s*link|your\s*phone|continuity\s*camera|smartphone|linked\s+phone|mobile\s+phone|\biphone\b|\bgalaxy\b|\bpixel\b|android(\s+\w+)?(\s+camera)?|camera\s*\(.*phone/i
export const BUILTIN_WEBCAM_PATTERN = /integrated|built-?in|internal\s+camera|laptop|easy\s*camera|chicony|realtek|usb\s*2\.0\s*hd|hd\s*webcam|rgb\s*camera/i
export const IR_CAMERA_PATTERN = /ir\s+camera|windows\s+hello|infrared/i
export const NO_PC_CAMERA = 'No PC webcam was found. ICE uses the laptop camera by default and will not auto-select Phone Link. Enable the computer camera, then click Refresh cameras. You can still pick another device in Settings.'

export function isPhoneLinkLabel(label) {
  return PHONE_LINK_PATTERN.test(String(label || ''))
}

export function isBuiltinWebcamLabel(label) {
  return BUILTIN_WEBCAM_PATTERN.test(String(label || ''))
}

export function isIrCameraLabel(label) {
  return IR_CAMERA_PATTERN.test(String(label || ''))
}

export function cameraOptionLabel(device) {
  const name = String(device?.label || '').trim() || 'Camera'
  if (isPhoneLinkLabel(name)) return `${name} · Phone Link`
  if (isIrCameraLabel(name)) return `${name} · IR / Windows Hello`
  if (isBuiltinWebcamLabel(name)) return `${name} · laptop webcam`
  return name
}

/**
 * Auto uses the built-in PC webcam, then any non-Phone-Link camera.
 * Phone Link is never chosen unless the user picks it in Settings.
 */
export function pickCamera(devices, preferredId = 'auto') {
  const cams = (devices || []).filter(d => !d.kind || d.kind === 'videoinput')
  if (!cams.length) {
    return { device: null, reason: 'none', help: 'No camera was found. Enable the laptop webcam, then click Refresh cameras.' }
  }
  if (preferredId && preferredId !== 'auto') {
    const exact = cams.find(d => d.deviceId === preferredId)
    if (exact) return { device: exact, reason: 'selected', help: '' }
    return { device: null, reason: 'missing-selected', help: 'That camera is no longer listed. Click Refresh cameras. Auto uses the PC webcam, not Phone Link.' }
  }
  const colorPc = cams.find(d => isBuiltinWebcamLabel(d.label) && !isPhoneLinkLabel(d.label) && !isIrCameraLabel(d.label))
  if (colorPc) return { device: colorPc, reason: 'laptop', help: '' }
  const pc = cams.find(d => isBuiltinWebcamLabel(d.label) && !isPhoneLinkLabel(d.label))
  if (pc) return { device: pc, reason: 'laptop', help: '' }
  const other = cams.find(d => !isPhoneLinkLabel(d.label))
  if (other) return { device: other, reason: 'pc', help: '' }
  return { device: null, reason: 'missing-pc', help: NO_PC_CAMERA }
}
