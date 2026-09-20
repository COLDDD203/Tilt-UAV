// Metres, using UAVvideo.m's unscaled geometry (VISUAL_SCALE is display-only).
// Shared by flight playback, passage planning, and aircraft inspection.
// Never resize the aircraft while it enters the passage.
export const DRONE_DIMENSIONS = Object.freeze({
  armHalfX: .079,
  armHalfY: .088,
  propellerRadius: .065,
  motorRadius: .009,
  motorHeight: .018,
  bodyHeight: .022,
})
