import { t } from '../i18n.js';
import { el, icon, minutesToTime } from '../utils.js';
import { 
  getData, addLesson, updateLesson, deleteLesson, updateLessonInstance, 
  ensurePackageEntry, getPackageByName, getAutoGroupColor, toggleCancelLessonInstance,
  GROUP_COLORS, saveData, processPastLessonsForCredits 
} from '../store.js';
import { render, showToast } from '../main.js';
import { isGroupLessonRecord, getKnownClientNames } from '../services/LessonService.js';
import { getDayScheduleHours } from '../views/SettingsView.js';

let editingLesson = null;

export function openLessonModal(dateStr, lesson = null) {
  editingLesson = lesson;
  const isEdit = !!lesson;
  const data = getData();
  const baseLesson = isEdit ? (data.lessons.find(l => l.id === lesson.id) || lesson) : null;
  const isRecurringInstance = !!(isEdit && lesson._recurringInstance && baseLesson?.recurring);
  const isGroupEdit = isGroupLessonRecord(lesson);
  const clientNames = getKnownClientNames(data);
  const initialType = isEdit && isGroupEdit ? 'group' : 'individual';

  history.pushState({ modalOpen: true }, '');

  const closeModal = (fromPopState = false) => {
    overlay.remove();
    window.removeEventListener('popstate', onPopState);
    if (!fromPopState) {
      history.back();
    }
  };

  const onPopState = (e) => {
    closeModal(true);
  };

  window.addEventListener('popstate', onPopState);

  const overlay = el('div', { className: 'modal-overlay', onClick: (e) => {
    if (e.target === overlay) closeModal();
  }});

  const modal = el('div', { className: 'modal', tabIndex: -1 });
  modal.appendChild(el('div', { className: 'modal-handle' }));
  modal.appendChild(el('h3', {}, isEdit ? t('editLesson') : t('newLesson')));

  const content = el('div');
  modal.appendChild(content);

  const modeRow = el('div', { className: 'lesson-type-switch' });
  const individualModeBtn = el('button', { className: 'lesson-type-btn', type: 'button' }, t('individualLesson'));
  const groupModeBtn = el('button', { className: 'lesson-type-btn', type: 'button' }, t('groupLesson'));
  modeRow.appendChild(individualModeBtn);
  modeRow.appendChild(groupModeBtn);
  content.appendChild(modeRow);

  const formHost = el('div');
  content.appendChild(formHost);

  const commonSection = el('div');
  const individualSection = el('div');
  const groupSection = el('div');

  const knownClientsDatalist = el('datalist', { id: 'lesson-client-list' });
  for (const name of clientNames) {
    knownClientsDatalist.appendChild(el('option', { value: name }));
  }
  modal.appendChild(knownClientsDatalist);

  let currentType = initialType;

  const lastCreatedLesson = data.lessons.length > 0 ? data.lessons[data.lessons.length - 1] : null;
  const startMinuteDefault = lesson ? lesson.startMinute : (lastCreatedLesson ? lastCreatedLesson.startMinute : 10 * 60);
  const durationDefault = lesson ? lesson.durationMinutes : 60;
  const recurringDefault = !!(
    lesson &&
    lesson.recurring &&
    (!lesson.recurringUntil || lesson._instanceDate !== lesson.recurringUntil)
  );

  const { startHour, endHour } = getDayScheduleHours();
  const startSelect = el('select', { className: 'form-input', id: 'lesson-start-select' });
  for (let m = startHour * 60; m < endHour * 60; m += 15) {
    const opt = el('option', { value: String(m) }, minutesToTime(m));
    if (startMinuteDefault === m) opt.selected = true;
    startSelect.appendChild(opt);
  }

  const durSelect = el('select', { className: 'form-input', id: 'lesson-duration-select' });
  for (const dur of [30, 45, 60, 90, 120]) {
    const opt = el('option', { value: String(dur) }, `${dur} ${t('min')}`);
    if (durationDefault === dur) opt.selected = true;
    durSelect.appendChild(opt);
  }

  const instrSelect = el('select', { className: 'form-input', id: 'lesson-instructor-select' });
  instrSelect.appendChild(el('option', { value: '' }, t('noInstructor')));
  for (const i of data.instructors) {
    const opt = el('option', { value: i.name }, i.name);
    if (lesson && lesson.instructor === i.name) opt.selected = true;
    instrSelect.appendChild(opt);
  }

  const recurToggle = el('div', {
    className: `toggle ${recurringDefault ? 'active' : ''}`,
    id: 'lesson-recurring-toggle',
    onClick: () => recurToggle.classList.toggle('active')
  });

  const titleInput = el('input', {
    className: 'form-input',
    type: 'text',
    placeholder: t('enterClientName'),
    value: lesson && !isGroupEdit ? lesson.title : '',
    id: 'lesson-title-input',
    list: 'lesson-client-list'
  });

  const horseSelect = el('select', { className: 'form-input', id: 'lesson-horse-select' });
  horseSelect.appendChild(el('option', { value: '' }, t('selectHorse')));
  for (const h of data.horses) {
    const opt = el('option', { value: h }, h);
    if (lesson && lesson.horse === h) opt.selected = true;
    horseSelect.appendChild(opt);
  }

  const packageModeDefault = lesson
    ? (lesson.packageMode !== undefined
      ? lesson.packageMode
      : (isGroupEdit || (Array.isArray(lesson.participants) && lesson.participants.length > 0)
        ? true
        : !!(lesson.title && getPackageByName(lesson.title))))
    : false;
  const packageModeToggle = el('div', {
    className: `toggle ${packageModeDefault ? 'active' : ''}`,
    id: 'lesson-package-toggle',
    onClick: () => packageModeToggle.classList.toggle('active')
  });

  const initialGroupColor = baseLesson?.groupColor || lesson?.groupColor || getAutoGroupColor();
  const groupColorInput = el('input', { type: 'hidden', value: initialGroupColor });
  const groupColorPalette = el('div', { className: 'color-palette' });

  GROUP_COLORS.forEach(color => {
    const chip = el('div', {
      className: `color-palette-chip ${initialGroupColor === color ? 'active' : ''}`,
      style: { backgroundColor: color },
      onClick: () => {
        groupColorPalette.querySelectorAll('.color-palette-chip').forEach(c => c.classList.remove('active'));
        chip.classList.add('active');
        groupColorInput.value = color;
      }
    }, icon('check'));
    groupColorPalette.appendChild(chip);
  });

  const participantList = el('div', { className: 'group-participants' });
  const participantRows = [];

  const addParticipantRow = (participant = {}) => {
    const row = el('div', { className: 'participant-row' });
    
    // Name input (Line 1)
    const nameInput = el('input', {
      className: 'form-input participant-name-input',
      type: 'text',
      placeholder: t('enterClientName'),
      value: participant.name || '',
      list: 'lesson-client-list'
    });
    const topRow = el('div', { className: 'participant-row-top' }, nameInput);

    // Controls (Line 2)
    const bottomRow = el('div', { className: 'participant-row-bottom' });

    const rowHorseSelect = el('select', {
      className: 'form-input participant-horse-select'
    });
    rowHorseSelect.appendChild(el('option', { value: '' }, t('noHorse')));
    for (const h of data.horses) {
      const opt = el('option', { value: h }, h);
      if (participant.horse === h) opt.selected = true;
      rowHorseSelect.appendChild(opt);
    }

    const removeBtn = el('button', {
      className: 'btn btn-secondary btn-sm participant-remove-btn',
      type: 'button',
      onClick: () => {
        if (participantRows.length <= 1) return;
        const index = participantRows.findIndex(entry => entry.row === row);
        if (index >= 0) participantRows.splice(index, 1);
        row.remove();
      }
    }, icon('close'));

    const packageMode = { value: participant.packageMode !== false };
    const packageToggle = el('div', {
      className: `toggle ${packageMode.value ? 'active' : ''}`,
      title: t('packageLessonMode'),
      onClick: () => {
        packageMode.value = !packageMode.value;
        packageToggle.classList.toggle('active', packageMode.value);
      }
    });

    const packageControl = el('div', { className: 'participant-package-control' },
      el('span', { className: 'participant-package-label' }, t('packageShort')),
      packageToggle
    );

    bottomRow.appendChild(rowHorseSelect);
    bottomRow.appendChild(removeBtn);
    bottomRow.appendChild(packageControl);

    row.appendChild(topRow);
    row.appendChild(bottomRow);

    participantRows.push({ row, nameInput, horseSelect: rowHorseSelect, packageMode });
    participantList.appendChild(row);
  };

  const initialGroupParticipants = isGroupEdit && Array.isArray(lesson?.participants) && lesson.participants.length > 0
    ? lesson.participants
    : (lesson && !isGroupEdit ? [{ name: lesson.title || '', horse: lesson.horse || '' }] : [{ name: '', horse: '' }]);
  for (const participant of initialGroupParticipants) {
    addParticipantRow(participant);
  }

  const addParticipantButton = el('button', {
    className: 'btn btn-secondary btn-sm',
    type: 'button',
    onClick: () => addParticipantRow()
  }, icon('add'), t('addParticipant'));

  const renderForm = () => {
    formHost.innerHTML = '';

    individualSection.innerHTML = '';
    groupSection.innerHTML = '';
    commonSection.innerHTML = '';


    const scheduleRow = el('div', { className: 'form-row' });
    const startGroup = el('div', { className: 'form-group' }, el('label', {}, t('startTime')), startSelect);
    const durGroup = el('div', { className: 'form-group' }, el('label', {}, t('duration')), durSelect);
    scheduleRow.appendChild(startGroup);
    scheduleRow.appendChild(durGroup);
    commonSection.appendChild(scheduleRow);

    const instrGroup = el('div', { className: 'form-group' }, el('label', {}, t('instructor')), instrSelect);
    commonSection.appendChild(instrGroup);

    const recurRow = el('div', { className: 'toggle-row' });
    recurRow.appendChild(el('span', {}, t('repeatWeekly')));
    recurRow.appendChild(recurToggle);
    commonSection.appendChild(recurRow);

    individualSection.appendChild(el('div', { className: 'form-group' }, el('label', {}, t('clientName')), titleInput));
    individualSection.appendChild(el('div', { className: 'form-group' }, el('label', {}, t('horse')), horseSelect));
    const packageRow = el('div', { className: 'toggle-row' });
    packageRow.appendChild(el('span', {}, t('packageLessonMode')));
    packageRow.appendChild(packageModeToggle);
    individualSection.appendChild(packageRow);

    const groupColorBlock = el('div', { className: 'form-group' });
    groupColorBlock.appendChild(el('label', {}, t('groupColor')));
    const groupColorRow = el('div', { className: 'group-color-row' });
    groupColorRow.appendChild(groupColorInput);
    groupColorRow.appendChild(groupColorPalette);
    groupColorBlock.appendChild(groupColorRow);
    groupSection.appendChild(groupColorBlock);

    const participantBlock = el('div', { className: 'form-group' });
    participantBlock.appendChild(el('label', {}, t('groupClients')));
    participantBlock.appendChild(participantList);
    participantBlock.appendChild(addParticipantButton);
    groupSection.appendChild(participantBlock);

    formHost.appendChild(commonSection);
    formHost.appendChild(individualSection);
    formHost.appendChild(groupSection);

    individualSection.classList.toggle('is-hidden', currentType !== 'individual');
    groupSection.classList.toggle('is-hidden', currentType !== 'group');
    individualModeBtn.classList.toggle('active', currentType === 'individual');
    groupModeBtn.classList.toggle('active', currentType === 'group');
  };

  const setMode = (mode) => {
    currentType = mode;
    renderForm();
  };

  individualModeBtn.addEventListener('click', () => setMode('individual'));
  groupModeBtn.addEventListener('click', () => setMode('group'));

  renderForm();

  // Buttons
  const btnGroup = el('div', { className: 'btn-group' });

  const getLessonPayload = () => {
    const startMinute = parseInt(startSelect.value);
    const durationMinutes = parseInt(durSelect.value);
    const instructor = instrSelect.value || null;
    const recurring = recurToggle.classList.contains('active');
    const packageMode = packageModeToggle.classList.contains('active');

    if (currentType === 'individual') {
      const title = titleInput.value.trim();
      if (!title) {
        titleInput.focus();
        return null;
      }

      return {
        lessonData: {
          lessonType: 'individual',
          title,
          date: dateStr,
          startMinute,
          durationMinutes,
          horse: horseSelect.value || null,
          instructor,
          packageMode,
          groupId: null,
          groupName: null,
          groupColor: null,
          participants: [],
          recurring,
        },
        title,
      };
    }

    const participants = participantRows.map(({ nameInput, horseSelect, packageMode }) => ({
      name: nameInput.value.trim(),
      horse: horseSelect.value || null,
      packageMode: packageMode.value,
    })).filter(participant => participant.name);

    if (participants.length === 0) {
      participantRows[0]?.nameInput.focus();
      return null;
    }

    return {
      lessonData: {
        lessonType: 'group',
        title: t('groupLesson'),
        groupName: null,
        groupId: null,
        groupColor: groupColorInput.value || initialGroupColor,
        date: dateStr,
        startMinute,
        durationMinutes,
        instructor,
        packageMode: true,
        participants,
        recurring,
        horse: null,
      },
      participants,
    };
  };

  const saveLesson = () => {
    const payload = getLessonPayload();
    if (!payload) return null;

    const lessonData = payload.lessonData;
    let mutated = false;
    const recurringDisabled = isRecurringInstance && !lessonData.recurring;
    const recurringReenabled = isRecurringInstance && lessonData.recurring && !!baseLesson?.recurringUntil;

    if (currentType === 'individual') {
      if (isRecurringInstance) {
        const instanceLessonData = { ...lessonData };
        if (recurringDisabled) {
          instanceLessonData.recurring = false;
          updateLesson(baseLesson.id, { recurringUntil: lesson._instanceDate }, { save: false });
        } else if (recurringReenabled) {
          updateLesson(baseLesson.id, { recurringUntil: null }, { save: false });
        }
        updateLessonInstance(baseLesson.id, lesson._instanceDate, instanceLessonData, { save: false });
      } else if (isEdit) {
        updateLesson(lesson.id, lessonData, { save: false });
      } else {
        addLesson(lessonData, { save: false });
      }
      mutated = true;

      if (lessonData.title) {
        ensurePackageEntry(lessonData.title, {
          save: false,
          hasPackageLessons: lessonData.packageMode
        });
        mutated = true;
      }
      if (mutated) saveData();
      return isEdit ? 'updated' : 'created';
    }

    const resolvedGroupColor = groupColorInput.value || lessonData.groupColor || baseLesson?.groupColor || initialGroupColor;

    // For group lessons, color change should apply to the whole series (base lesson)
    if (baseLesson && baseLesson.groupColor !== resolvedGroupColor) {
      updateLesson(baseLesson.id, { groupColor: resolvedGroupColor }, { save: false });
      // Clear any individual color overrides from all instances to ensure uniformity across the series
      const targetLesson = getData().lessons.find(l => l.id === baseLesson.id);
      if (targetLesson && targetLesson.instanceOverrides) {
        for (const dateKey of Object.keys(targetLesson.instanceOverrides)) {
          delete targetLesson.instanceOverrides[dateKey].groupColor;
        }
      }
    }

    if (isRecurringInstance) {
      const instanceLessonData = {
        ...lessonData,
        title: t('groupLesson'),
        groupName: null,
        groupId: null,
        groupColor: resolvedGroupColor,
        recurring: recurringDisabled ? false : lessonData.recurring,
      };
      if (recurringDisabled) {
        updateLesson(baseLesson.id, { recurringUntil: lesson._instanceDate }, { save: false });
      } else if (recurringReenabled) {
        updateLesson(baseLesson.id, { recurringUntil: null }, { save: false });
      }
      updateLessonInstance(baseLesson.id, lesson._instanceDate, instanceLessonData, { save: false });
      for (const participant of payload.participants || []) {
        ensurePackageEntry(participant.name, {
          save: false,
          hasPackageLessons: participant.packageMode !== false
        });
      }
      saveData();
      return 'updated';
    }

    const seriesLessonData = {
      ...lessonData,
      title: t('groupLesson'),
      groupName: null,
      groupId: null,
      groupColor: resolvedGroupColor,
      recurring: isRecurringInstance ? true : lessonData.recurring,
    };

    if (recurringDisabled && isRecurringInstance) {
      updateLesson(lesson.id, { recurringUntil: lesson._instanceDate }, { save: false });
      updateLessonInstance(lesson.id, lesson._instanceDate, { recurring: false }, { save: false });
    } else if (recurringReenabled && isRecurringInstance) {
      updateLesson(lesson.id, { recurringUntil: null }, { save: false });
    }

    if (isEdit) {
      updateLesson(lesson.id, seriesLessonData, { save: false });
    } else {
      addLesson(seriesLessonData, { save: false });
    }
    mutated = true;

    for (const participant of payload.participants || []) {
      ensurePackageEntry(participant.name, {
        save: false,
        hasPackageLessons: participant.packageMode !== false
      });
      mutated = true;
    }

    if (mutated) saveData();

    return isEdit ? 'updated' : 'created';
  };

  if (isEdit) {
    btnGroup.appendChild(el('button', {
      className: 'btn btn-danger btn-sm',
      onClick: () => {
        deleteLesson(lesson.id);
        closeModal();
        showToast(t('lessonDeleted'), 'delete');
        render();
      }
    }, icon('delete'), t('deleteKey')));

    const isCancelled = lesson.cancelledDates && lesson.cancelledDates.includes(dateStr);
    btnGroup.appendChild(el('button', {
      className: 'btn btn-secondary btn-sm',
      onClick: () => {
        toggleCancelLessonInstance(lesson.id, dateStr);
        processPastLessonsForCredits();
        closeModal();
        showToast(isCancelled ? t('lessonRestored') : t('lessonCancelled'), isCancelled ? 'restore' : 'cancel');
        render();
      }
    }, icon(isCancelled ? 'restore' : 'cancel'), isCancelled ? t('restore') : t('cancel')));
  }

  btnGroup.appendChild(el('button', {
    className: 'btn btn-primary btn-sm',
    style: { marginLeft: 'auto' },
    onClick: () => {
      const result = saveLesson();
      if (!result) return;
      showToast(result === 'created' ? t('lessonCreated') : t('lessonUpdated'), 'check_circle');
      closeModal();
      render();
    }
  }, icon('check'), isRecurringInstance ? t('saveOccurrence') : (isEdit ? t('update') : t('create'))));

  modal.appendChild(btnGroup);
  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  setTimeout(() => modal.focus(), 300);
}
