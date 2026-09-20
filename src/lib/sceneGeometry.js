import { sweptAircraftBounds } from './droneModel.js'

// Display-only ground contact for recordings whose centre height reaches zero.
// Apply the original pose first on EVERY update; never edit the source sample.
// A valid geometry-planned flight already clears the floor and needs no lift.
export function applyGroundContact(rig, groundZ = 0) {
  const deficit = groundZ - sweptAircraftBounds(rig).min.z
  const lift = deficit > 1e-9 ? deficit : 0
  rig.drone.position.z += lift
  return lift
}
