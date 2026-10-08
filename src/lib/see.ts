import { FaceDetector, FilesetResolver, ObjectDetector } from '@mediapipe/tasks-vision'
import { grabFrame, holdCamera, releaseCamera, listCameras, activeCameraLabel } from './camera'
import { isPhoneLinkLabel } from './camera-pick.mjs'

const WASM_BASE = '/mediapipe'
const FACE_MODEL = 'https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite'
const OBJECT_MODEL = 'https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite0/float16/1/efficientdet_lite0.tflite'

let faces: FaceDetector | null = null
let objects: ObjectDetector | null = null

export function isLookAsk(text: string) {
  return /qué\s+ves|que\s+ves|mírame|mirame|mira(\s+(esto|me|aquí|aqui|por la cámara|la cámara))|usa\s+la\s+cámara|abre\s+la\s+cámara|cómo\s+me\s+veo|cuánt[oa]s\s+(personas|caras|dispositivos|objetos)|what (do you|can you) see|what(?:'s| is) in front|how do i look|how many (people|faces|persons|devices|objects)|what am i (holding|wearing)|is anyone (there|behind)|look at (me|this)|look through (the )?camera|use (the )?camera|open (the )?camera/i.test(text)
}

export function isDeviceAsk(text: string) {
  return /how many (cameras|webcams|mics|microphones|speakers)|(?:list|what(?:'s| are) the) (cameras|microphones)|cuánt[oa]s\s+(cámaras|camaras|micrófonos|microfonos|altavoces)/i.test(text)
}

export async function listLocalMedia() {
  if (!navigator.mediaDevices?.enumerateDevices) return { cameras: 0, mics: 0, speakers: 0, cameraNames: [] as string[], phoneLink: false }
  const devices = await navigator.mediaDevices.enumerateDevices()
  const cameras = devices.filter(d => d.kind === 'videoinput')
  return {
    cameras: cameras.length,
    cameraNames: cameras.map(d => d.label || 'Camera'),
    phoneLink: cameras.some(d => isPhoneLinkLabel(d.label)),
    mics: devices.filter(d => d.kind === 'audioinput').length,
    speakers: devices.filter(d => d.kind === 'audiooutput').length,
  }
}

async function waitReady() {
  const video = await holdCamera()
  for (let i = 0; i < 50; i++) {
    if (video.videoWidth) return video
    await new Promise(r => setTimeout(r, 40))
  }
  throw new Error('The camera opened but no picture arrived. Allow camera access for this localhost page.')
}

function lightingOf(video: HTMLVideoElement) {
  const canvas = document.createElement('canvas')
  canvas.width = 64
  canvas.height = 36
  const ctx = canvas.getContext('2d')
  if (!ctx) return 'unknown light'
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data
  let sum = 0
  for (let i = 0; i < data.length; i += 4) sum += (data[i] + data[i + 1] + data[i + 2]) / 3
  const mean = sum / (data.length / 4)
  if (mean < 28) return 'very dark'
  if (mean < 70) return 'dim'
  if (mean > 200) return 'very bright'
  return 'reasonably lit'
}

async function visionTasks() {
  return FilesetResolver.forVisionTasks(WASM_BASE)
}

async function countFaces(video: HTMLVideoElement) {
  if (!faces) {
    const vision = await visionTasks()
    faces = await FaceDetector.createFromOptions(vision, {
      baseOptions: { modelAssetPath: FACE_MODEL, delegate: 'CPU' },
      runningMode: 'IMAGE',
      minDetectionConfidence: 0.45,
    })
  }
  return faces.detect(video).detections?.length || 0
}

async function namedObjects(video: HTMLVideoElement) {
  if (!objects) {
    const vision = await visionTasks()
    objects = await ObjectDetector.createFromOptions(vision, {
      baseOptions: { modelAssetPath: OBJECT_MODEL, delegate: 'CPU' },
      runningMode: 'IMAGE',
      scoreThreshold: 0.45,
      maxResults: 8,
    })
  }
  const hits = objects.detect(video).detections || []
  const names = hits.map(d => d.categories?.[0]?.categoryName?.replace(/_/g, ' ')).filter(Boolean) as string[]
  return [...new Set(names)]
}

export async function describeDevices() {
  let listed: Awaited<ReturnType<typeof listCameras>> = []
  try { listed = await listCameras() } catch { /* labels may need a later permission grant */ }
  const media = await listLocalMedia()
  const names = listed.length ? listed.map(c => c.option) : media.cameraNames
  const bits = [`This PC shows ${media.cameras} camera${media.cameras === 1 ? '' : 's'}`]
  if (names.length) bits.push('(' + names.join('; ') + ')')
  bits.push(`${media.mics} microphone${media.mics === 1 ? '' : 's'}`, `and ${media.speakers} speaker output${media.speakers === 1 ? '' : 's'}`)
  if (listed.some(c => !c.phoneLink) || media.cameraNames.some(n => n && !/phone\s*link|your\s*phone|continuity/i.test(n))) bits.push('ICE uses the PC webcam unless you pick another in Settings.')
  if (listed.some(c => c.phoneLink) || media.phoneLink) bits.push('Phone Link is listed but is not selected automatically.')
  return bits.join(', ') + '. Nothing is sent off this computer.'
}

export async function describeLocalView(keepLive = false) {
  const media = await listLocalMedia()
  let held = false
  try {
    const video = await waitReady()
    held = true
    grabFrame()
    const light = lightingOf(video)
    let people = 0
    let things: string[] = []
    try { people = await countFaces(video) } catch { /* optional local detector */ }
    try { things = await namedObjects(video) } catch { /* optional local detector */ }
    const parts = []
    if (people === 0) parts.push('I do not see a clear face.')
    else parts.push(people === 1 ? 'I see one person.' : `I see ${people} people.`)
    if (things.length) parts.push('Nearby objects: ' + things.slice(0, 6).join(', ') + '.')
    parts.push(`The room looks ${light}.`)
    const using = activeCameraLabel()
    if (using) parts.push(`I am using ${using}.`)
    parts.push(`This PC has ${media.cameras} camera${media.cameras === 1 ? '' : 's'} and ${media.mics} microphone${media.mics === 1 ? '' : 's'}.`)
    parts.push('The picture stayed on this computer.')
    return parts.join(' ')
  } finally {
    if (held && !keepLive) releaseCamera()
  }
}
