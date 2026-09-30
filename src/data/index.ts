import balance from './balance.json';
import units from './units.json';
import chains from './chains.json';
import monsters from './monsters.json';
import events from './events.json';
import days from './days.json';
import diary from './diary.json';
import endings from './endings.json';
import { validateGameData, type ValidationResult } from './validate';

export const rawGameData = { balance, units, chains, monsters, events, days, diary, endings };

export function loadGameData(): ValidationResult {
  // structuredClone: 이후 디버그 오버라이드가 import된 원본을 건드리지 않도록
  return validateGameData(structuredClone(rawGameData));
}
