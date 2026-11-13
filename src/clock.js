// The simulated time of day, and what the sun and the weather do at that time.
// Times are minutes since midnight (0 .. 1440).

export const DAY = 1440;
export const SPEEDS = [1, 60, 300, 600, 1800, 3600]; // simulated seconds per real second
const WARMEST = 15 * 60; // the afternoon peak of the outdoor temperature

const realNow = () => {
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60;
};

export const clockDefaults = () => ({
  minutes: realNow(),
  speed: 600,
  running: false,
  sunrise: 6 * 60 + 30,
  sunset: 20 * 60 + 30,
  temp_min: 8,
  temp_max: 22,
});

/** "07:30" -> 450; undefined if it is not a time. */
export function parseTime(text) {
  if (text === 'now') return realNow();
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(text ?? '').trim());
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return undefined;
  return Number(m[1]) * 60 + Number(m[2]);
}

export function formatTime(minutes) {
  const m = Math.floor(((minutes % DAY) + DAY) % DAY);
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/** 0 at night, rising to 1 at solar noon. */
export function daylight({ minutes, sunrise, sunset }) {
  if (minutes <= sunrise || minutes >= sunset) return 0;
  return Math.sin((Math.PI * (minutes - sunrise)) / (sunset - sunrise));
}

/** Coldest at sunrise, warmest in the afternoon, a smooth curve in between. */
export function outdoorTemperature({ minutes, sunrise, temp_min, temp_max }) {
  const peak = Math.max(WARMEST, sunrise + 60);
  const sinceSunrise = (minutes - sunrise + DAY) % DAY;
  const warming = peak - sunrise;
  const phase = sinceSunrise < warming
    ? sinceSunrise / warming // 0 .. 1 while it warms up
    : 1 - (sinceSunrise - warming) / (DAY - warming); // 1 .. 0 while it cools down
  const share = (1 - Math.cos(Math.PI * phase)) / 2;
  return Math.round((temp_min + (temp_max - temp_min) * share) * 10) / 10;
}

/** Humid in the cold morning, dry in the warm afternoon. */
export function outdoorHumidity(clock) {
  const { temp_min, temp_max } = clock;
  const share = temp_max > temp_min ? (outdoorTemperature(clock) - temp_min) / (temp_max - temp_min) : 0.5;
  return Math.round(90 - 45 * share);
}

export function environment(clock) {
  const light = daylight(clock);
  return {
    time: formatTime(clock.minutes),
    daylight: Math.round(light * 100),
    sun: light > 0 ? 'above_horizon' : 'below_horizon',
    outdoor_temperature: outdoorTemperature(clock),
    outdoor_humidity: outdoorHumidity(clock),
  };
}
