import { t } from '../i18n.js';
import { el } from '../utils.js';
import { getData, getLessonsForDate } from '../store.js';
import { render } from '../main.js';
import { isGroupLessonRecord, isCustomLessonRecord, getLessonParticipants } from '../services/LessonService.js';
import { parseDate, getDatesInRange, getWeekRange } from '../utils.js';

let horseViewRange = null;

export function buildHorsesView() {
  const container = el('div', { id: 'horses-view-container' });
  try {
    const data = getData();
    if (!data) throw new Error('No data available');

    // Range setup
    if (!horseViewRange) {
      const dates = getWeekRange();
      if (!dates || dates.length < 7) throw new Error('Week range generation failed');
      horseViewRange = { from: dates[0], to: dates[6] };
    }

    const rangeHeader = el('div', {
      style: { padding: '16px', background: 'var(--bg-card)', borderBottom: '1px solid var(--border)', marginBottom: '4px' }
    });

    const fromInput = el('input', { type: 'date', className: 'form-input', value: horseViewRange.from || '', style: { width: 'auto', display: 'inline-block' } });
    const toInput = el('input', { type: 'date', className: 'form-input', value: horseViewRange.to || '', style: { width: 'auto', display: 'inline-block' } });
    const applyBtn = el('button', {
      className: 'btn btn-primary btn-sm',
      onClick: () => {
        if (fromInput.value && toInput.value) {
          horseViewRange = { from: fromInput.value, to: toInput.value };
        }
        render();
      }
    }, t('apply'));

    const inputsRow = el('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' } },
      el('label', { style: { fontSize: '0.8rem' } }, t('dateFrom')),
      fromInput,
      el('label', { style: { fontSize: '0.8rem' } }, t('dateTo')),
      toInput,
      applyBtn
    );

    rangeHeader.appendChild(inputsRow);
    container.appendChild(rangeHeader);

    // Group lessons by horse for this range
    const dateList = getDatesInRange(horseViewRange.from, horseViewRange.to);
    const workload = {};
    const horses = data.horses || [];
    horses.forEach(h => { workload[h] = 0; });

    data.lessons.forEach(lesson => {
      if (!lesson || !lesson.date || !lesson.title) return;
      if (lesson.recurring && lesson.recurringUntil && lesson.date > lesson.recurringUntil) return;
      const participantHorses = isGroupLessonRecord(lesson) || isCustomLessonRecord(lesson)
        ? getLessonParticipants(lesson).map(p => p.horse).filter(Boolean)
        : (lesson.horse ? [lesson.horse] : []);

      if (participantHorses.length === 0) return;

      dateList.forEach(dateStr => {
        if (lesson.recurring && lesson.recurringUntil && dateStr > lesson.recurringUntil) return;
        const lessonDate = lesson.date === dateStr;
        const recurringMatch = lesson.recurring && (() => {
          const date = parseDate(dateStr);
          const start = parseDate(lesson.date);
          return date > start && date.getDay() === start.getDay();
        })();

        if (!lessonDate && !recurringMatch) return;

        const isCancelled = lesson.cancelledDates && lesson.cancelledDates.includes(dateStr);
        if (isCancelled) return;

        for (const horse of participantHorses) {
          if (Object.prototype.hasOwnProperty.call(workload, horse)) {
            workload[horse] += lesson.durationMinutes;
          }
        }
      });
    });

    const list = el('div', { className: 'horse-workload-list' });
    const sortedHorses = [...horses].sort((a, b) => (workload[b] || 0) - (workload[a] || 0));

    if (sortedHorses.length === 0) {
      list.appendChild(el('div', { style: { padding: '24px', textAlign: 'center', color: 'var(--text-secondary)' } }, t('noHistory')));
    } else {
      for (const horse of sortedHorses) {
        const mins = workload[horse] || 0;
        const hours = Math.floor(mins / 60);
        const remMins = mins % 60;

        const row = el('div', {
          style: {
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            padding: '14px 16px',
            borderBottom: '1px solid var(--border)',
            background: 'var(--bg-card)'
          }
        });

        row.appendChild(el('div', { style: { fontWeight: '600' } }, horse));
        const color = mins > 600 ? 'var(--red)' : 'var(--text-secondary)';
        const timeText = hours > 0 ? `${hours}${t('h')} ${remMins}${t('m')}` : `${remMins}${t('m')}`;
        row.appendChild(el('div', { style: { fontWeight: '700', color } }, timeText));
        list.appendChild(row);
      }
    }

    container.appendChild(list);
  } catch (e) {
    console.error('[horses] error building view:', e);
    container.appendChild(el('div', { style: { padding: '24px', color: 'var(--red)' } }, 'View Error: ' + e.message));
  }
  return container;
}
