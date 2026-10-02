import balance from './balance.json';
import chains from './chains.json';
import monsters from './monsters.json';
import events from './events.json';
import days from './days.json';
import stages from './stages.json';
import bonds from './bonds.json';
import chapter from './chapter.json';
import chapterComplete from './chapter_complete.json';
import recipes from './recipes.json';
import heroes from './heroes.json';
import bookSkills from './bookSkills.json';
import { validateGameData, type ValidationResult } from './validate';

export const rawGameData = { balance, heroes, chains, monsters, events, days, stages, bonds, chapter, chapterComplete, recipes, bookSkills };

export function loadGameData(): ValidationResult {
  // structuredClone: 이후 디버그 오버라이드가 import된 원본을 건드리지 않도록
  return validateGameData(structuredClone(rawGameData));
}
