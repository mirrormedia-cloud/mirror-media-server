import moment from "moment-timezone";
import { config } from "../../config";

const TZ = config.app.timezone;

export function getTodayDate(): string {
  return moment().tz(TZ).format("YYYY-MM-DD");
}

export function getTimestamp(): string {
  return moment().tz(TZ).format("YYYY-MM-DD HH:mm:ss");
}

export function getTimezoneOffset(): string {
  return moment().tz(TZ).format("Z");
}
