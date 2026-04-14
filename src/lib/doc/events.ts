export const DOC_EVENTS = {
  DOC_UPDATED: 'docUpdated',
  DOC_ERROR: 'docError',
  MEMBERS_UPDATED: 'membersUpdated', // payload: string[] of member addresses
  RTC_CONNECTED: 'rtcConnected', // first Swarm-signaled WebRTC data channel opened
}
