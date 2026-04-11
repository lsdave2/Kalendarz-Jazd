import { t } from '../i18n.js';

export function isGroupLessonRecord(lesson) {
  return !!lesson && Array.isArray(lesson.participants) && lesson.participants.length > 0;
}

export function getLessonParticipants(lesson) {
  if (!isGroupLessonRecord(lesson)) return [];
  return lesson.participants
    .map(participant => {
      const name = (participant?.name || '').trim();
      const horse = participant?.horse || null;
      const packageName = (participant?.packageName || name).trim();
      const packageMode = participant?.packageMode !== false;
      if (!name) return null;
      return { name, horse, packageName, packageMode };
    })
    .filter(Boolean);
}

export function getKnownClientNames(data) {
  const names = [];
  for (const pkg of data.packages || []) {
    if (pkg?.name) names.push(pkg.name);
  }
  return [...new Set(names.map(name => name.trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

export function getLessonDisplayName(lesson) {
  if (!lesson) return '';
  if (isGroupLessonRecord(lesson)) {
    return t('groupLesson');
  }
  return lesson.title || '';
}
