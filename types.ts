export enum STATUS {
  COOLDOWN,
  WAIT,
  READY,
  GAVE_UP
}

// TODO update these comments
/**
 * textMatch - when this text is no longer matched, an email is sent.
 * interval - in miliseconds
 * msgCooldown - in miliseconds
 */
export interface Site {
  name: string
  url: string
  textMatch: string
  interval: number
  msgCooldown: number
  status: STATUS
}
