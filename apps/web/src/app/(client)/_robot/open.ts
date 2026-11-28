/**
 * The one way a page asks the masthead's robot to open its conversation (`RobotPresence`): an event on the window, so a
 * stage's "Ask me" needs no context or store, and a page without the masthead simply has nobody listening.
 */
export const ROBOT_OPEN_EVENT = 'inrp2p:robot-open';

export function openRobot(): void {
  window.dispatchEvent(new CustomEvent(ROBOT_OPEN_EVENT, { detail: { ask: true } }));
}
