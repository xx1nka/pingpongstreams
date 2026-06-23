(function () {
  "use strict";

  const pageType = document.body.dataset.page;
  const isControlPage = document.body.classList.contains("control-page") || pageType === "control";
  const isOverlayPage = document.body.classList.contains("overlay-page") || pageType === "overlay";
  const databasePath = window.scoreboardDatabasePath || "scoreboard/current";
  const localStorageKey = "pingpong-scoreboard-state";
  const AUTO_ADVANCE_DELAY_MS = 2000;
  const AUTO_ADVANCE_SECONDS = Math.round(AUTO_ADVANCE_DELAY_MS / 1000);

  const defaultState = {
    leftLabel: "ЛЕВАЯ СТОРОНА",
    rightLabel: "ПРАВАЯ СТОРОНА",
    leftPoints: 0,
    rightPoints: 0,
    leftSets: 0,
    rightSets: 0,
    currentSet: 1,
    bestOf: 3,
    firstServer: "left",
    autoAdvanceEnabled: true,
    setEndedPending: false,
    matchEnded: false,
    matchWinner: null,
    lastSetWinner: null,
    pendingSetWinner: null,
    pendingAutoAdvanceAt: null,
    timerRunning: false,
    timerStartedAt: null,
    elapsedMs: 0,
    updatedAt: Date.now()
  };

  let state = { ...defaultState };
  let matchRef = null;
  let auth = null;
  let currentUser = null;
  let isAdmin = false;
  let authReady = false;
  let usingFirebase = false;
  let localHistory = [];
  let timerFrame = null;
  let pendingAutoAdvanceTimer = null;
  let pendingAutoAdvanceKey = null;
  let pendingAutoAdvanceRunning = false;
  let receivedState = false;
  let previousOverlaySnapshot = null;

  const overlayEls = {
    leftPanel: document.querySelector(".side-panel-left"),
    rightPanel: document.querySelector(".side-panel-right"),
    centerPanel: document.querySelector(".center-panel"),
    leftLabel: document.getElementById("overlay-left-label"),
    rightLabel: document.getElementById("overlay-right-label"),
    leftPoints: document.getElementById("overlay-left-points"),
    rightPoints: document.getElementById("overlay-right-points"),
    leftSets: document.getElementById("overlay-left-sets"),
    rightSets: document.getElementById("overlay-right-sets"),
    timer: document.getElementById("overlay-timer"),
    meta: document.getElementById("overlay-meta"),
    leftServe1: document.getElementById("left-serve-1"),
    leftServe2: document.getElementById("left-serve-2"),
    rightServe1: document.getElementById("right-serve-1"),
    rightServe2: document.getElementById("right-serve-2")
  };

  const controlEls = {
    connection: document.getElementById("connection-status"),
    leftLabel: document.getElementById("control-left-label"),
    rightLabel: document.getElementById("control-right-label"),
    leftPoints: document.getElementById("control-left-points"),
    rightPoints: document.getElementById("control-right-points"),
    sets: document.getElementById("control-sets"),
    timer: document.getElementById("control-timer"),
    meta: document.getElementById("control-meta"),
    status: document.getElementById("match-status"),
    labelsForm: document.getElementById("labels-form"),
    leftInput: document.getElementById("left-label-input"),
    rightInput: document.getElementById("right-label-input"),
    bestOfSelect: document.getElementById("best-of-select"),
    autoAdvanceCheckbox: document.getElementById("auto-advance-checkbox"),
    authForm: document.getElementById("auth-form"),
    authEmail: document.getElementById("auth-email-input"),
    authPassword: document.getElementById("auth-password-input"),
    authStatus: document.getElementById("auth-status"),
    authSignIn: document.getElementById("auth-sign-in-button"),
    authSignOut: document.getElementById("auth-sign-out-button"),
    pointIncreaseButtons: Array.from(document.querySelectorAll('button[data-action="point"][data-delta="1"]')),
    writeControls: Array.from(document.querySelectorAll('button[data-action], #best-of-select, #auto-advance-checkbox, #left-label-input, #right-label-input, #labels-form button'))
  };

  startApp();

  // Инициализирует источник данных: Firebase, если SDK доступен, иначе локальный fallback.
  function startApp() {
    const hasFirebaseConfig = Boolean(window.firebaseConfig && window.firebaseConfig.databaseURL);
    const hasFirebaseSdk = Boolean(window.firebase && window.firebase.database);

    if (hasFirebaseConfig && hasFirebaseSdk) {
      try {
        window.firebase.initializeApp(window.firebaseConfig);
        matchRef = window.firebase.database().ref(databasePath);
        usingFirebase = true;
        setConnectionStatus("Firebase подключен", "online");
        subscribeFirebase();
      } catch (error) {
        console.error("Firebase init failed", error);
        useLocalFallback("Firebase не запустился, используется localStorage");
      }
    } else {
      useLocalFallback("Firebase недоступен, используется localStorage");
    }

    if (isControlPage) {
      setupControlAuth();
      bindControlEvents();
    }

    startRenderLoop();
  }

  // Подписывает страницу на Realtime Database и создает стартовое состояние с control.html.
  function subscribeFirebase() {
    matchRef.on("value", function (snapshot) {
      const value = snapshot.val();

      if (!value && isControlPage && canWrite()) {
        matchRef.set({ ...defaultState, updatedAt: Date.now() });
        return;
      }

      state = normalizeState(value || state);
      receivedState = true;
      renderState();
    }, function (error) {
      console.error("Firebase read failed", error);
      useLocalFallback("Ошибка Firebase, используется localStorage");
    });
  }

  // Включает запасной режим для проверки на одном компьютере без Firebase.
  function useLocalFallback(message) {
    usingFirebase = false;
    state = normalizeState(readLocalState());
    receivedState = true;
    setConnectionStatus(message, "offline");
    renderState();

    if (isControlPage) {
      authReady = true;
      setAuthStatus("Локальный режим: запись доступна без Firebase Auth");
      updateWriteControls();
    }

    if (isControlPage && !window.localStorage.getItem(localStorageKey)) {
      writeLocalState(state);
    }

    window.addEventListener("storage", function (event) {
      if (event.key !== localStorageKey || !event.newValue) {
        return;
      }

      state = normalizeState(JSON.parse(event.newValue));
      receivedState = true;
      renderState();
    });
  }

  function setupControlAuth() {
    if (!isControlPage) {
      return;
    }

    if (!usingFirebase) {
      authReady = true;
      setAuthStatus("Локальный режим: запись доступна без Firebase Auth");
      updateWriteControls();
      return;
    }

    if (!window.firebase || !window.firebase.auth) {
      authReady = true;
      currentUser = null;
      isAdmin = false;
      setAuthStatus("Firebase Auth недоступен");
      updateWriteControls();
      return;
    }

    auth = window.firebase.auth();
    setAuthStatus("Не авторизован");

    auth.onAuthStateChanged(function (user) {
      currentUser = user || null;
      isAdmin = false;
      authReady = true;
      clearPendingAutoAdvanceTimer();

      if (!currentUser) {
        setAuthStatus("Не авторизован");
        updateWriteControls();
        renderState();
        return;
      }

      setAuthStatus("Проверка прав администратора...");
      updateWriteControls();
      window.firebase.database().ref("admins/" + currentUser.uid).once("value")
        .then(function (snapshot) {
          isAdmin = snapshot.val() === true;
          setAuthStatus(isAdmin ? "Вы вошли как: " + (currentUser.email || currentUser.uid) : "Нет прав администратора");
          updateWriteControls();
          renderState();
        })
        .catch(function (error) {
          isAdmin = false;
          setAuthStatus("Ошибка проверки прав: " + getErrorMessage(error));
          updateWriteControls();
          renderState();
        });
    });
  }

  function signInControl(email, password) {
    if (!auth) {
      setAuthStatus("Firebase Auth недоступен");
      return;
    }

    setAuthStatus("Вход...");
    auth.signInWithEmailAndPassword(email, password)
      .then(function () {
        if (controlEls.authPassword) {
          controlEls.authPassword.value = "";
        }
      })
      .catch(function (error) {
        currentUser = null;
        isAdmin = false;
        setAuthStatus("Ошибка входа: " + getErrorMessage(error));
        updateWriteControls();
      });
  }

  function signOutControl() {
    if (!auth) {
      return;
    }

    clearPendingAutoAdvanceTimer();
    auth.signOut().catch(function (error) {
      setAuthStatus("Ошибка выхода: " + getErrorMessage(error));
    });
  }

  function canWrite() {
    if (!isControlPage) {
      return false;
    }

    if (!usingFirebase) {
      return true;
    }

    return Boolean(authReady && currentUser && isAdmin);
  }

  function updateWriteControls() {
    if (!isControlPage) {
      return;
    }

    const writeAllowed = canWrite();
    controlEls.writeControls.forEach(function (element) {
      element.disabled = !writeAllowed;
    });

    if (writeAllowed && state.setEndedPending) {
      controlEls.pointIncreaseButtons.forEach(function (button) {
        button.disabled = true;
      });
    }

    if (controlEls.authSignOut) {
      controlEls.authSignOut.disabled = !currentUser;
    }
  }

  function setAuthStatus(text) {
    setText(controlEls.authStatus, text);
  }

  function getErrorMessage(error) {
    return error && error.message ? error.message : "неизвестная ошибка";
  }

  // Назначает обработчики кнопок и формы на странице управления.
  function bindControlEvents() {
    if (controlEls.authForm) {
      controlEls.authForm.addEventListener("submit", function (event) {
        event.preventDefault();
        signInControl(controlEls.authEmail.value.trim(), controlEls.authPassword.value);
      });
    }

    if (controlEls.authSignOut) {
      controlEls.authSignOut.addEventListener("click", signOutControl);
    }

    document.addEventListener("click", function (event) {
      const button = event.target.closest("button[data-action]");
      if (!button) {
        return;
      }

      const action = button.dataset.action;
      const side = button.dataset.side;
      const delta = Number(button.dataset.delta || 0);

      if (action === "point") {
        updateMatch(function (current) {
          return changePoints(current, side, delta);
        });
      }

      if (action === "set") {
        updateMatch(function (current) {
          current = clearAutomationFlags(current);
          current[side + "Sets"] = clampScore(current[side + "Sets"] + delta);
          return refreshMatchEndFromSets(current);
        });
      }

      if (action === "timer-start") {
        updateMatch(startTimer);
      }

      if (action === "timer-pause") {
        updateMatch(pauseTimer);
      }

      if (action === "timer-reset") {
        updateMatch(resetTimer);
      }

      if (action === "new-set") {
        updateMatch(newSet);
      }

      if (action === "reset-match") {
        updateMatch(resetMatch);
      }

      if (action === "toggle-first-server") {
        updateMatch(function (current) {
          current = clearAutomationFlags(current);
          current.firstServer = otherSide(current.firstServer);
          return refreshMatchEndFromSets(current);
        });
      }

      if (action === "swap-sides") {
        updateMatch(swapSides);
      }

      if (action === "undo") {
        undoLastAction();
      }
    });

    controlEls.labelsForm.addEventListener("submit", function (event) {
      event.preventDefault();
      updateMatch(function (current) {
        current = clearSetPendingFields(current);
        current.leftLabel = cleanLabel(controlEls.leftInput.value, defaultState.leftLabel);
        current.rightLabel = cleanLabel(controlEls.rightInput.value, defaultState.rightLabel);
        return refreshMatchEndFromSets(current);
      });
    });

    controlEls.bestOfSelect.addEventListener("change", function () {
      updateMatch(function (current) {
        current = clearAutomationFlags(current);
        current.bestOf = normalizeBestOf(controlEls.bestOfSelect.value);
        current.currentSet = Math.min(current.currentSet, current.bestOf);
        return refreshMatchEndFromSets(current);
      });
    });

    if (controlEls.autoAdvanceCheckbox) {
      controlEls.autoAdvanceCheckbox.addEventListener("change", function () {
        updateMatch(function (current) {
          current.autoAdvanceEnabled = controlEls.autoAdvanceCheckbox.checked;
          current = clearSetPendingFields(current);
          return refreshMatchEndFromSets(current);
        });
      });
    }
  }

  // Обновляет матч через Firebase transaction или через localStorage fallback.
  function updateMatch(mutator, options) {
    if (!canWrite()) {
      return null;
    }

    const saveHistory = !options || options.saveHistory !== false;

    if (usingFirebase && matchRef) {
      return matchRef.transaction(function (currentValue) {
        const current = normalizeState(currentValue || defaultState);
        const history = Array.isArray(current.history) ? current.history.slice(-19) : [];
        const mutated = mutator({ ...current });

        if (!mutated) {
          return currentValue || stripHistory(current);
        }

        const next = normalizeState(mutated);
        next.history = saveHistory ? history.concat(stripHistory(current)) : history;
        next.updatedAt = Date.now();
        return next;
      });
    }

    const mutated = mutator({ ...state });
    if (!mutated) {
      return null;
    }

    if (saveHistory) {
      localHistory = localHistory.concat(stripHistory(state)).slice(-20);
    }

    state = normalizeState(mutated);
    state.updatedAt = Date.now();
    writeLocalState(state);
    renderState();
    return state;
  }

  // Откатывает последнее действие, если история еще доступна.
  function undoLastAction() {
    if (!canWrite()) {
      return;
    }

    clearPendingAutoAdvanceTimer();

    if (usingFirebase && matchRef) {
      matchRef.transaction(function (currentValue) {
        const current = normalizeState(currentValue || defaultState);
        const history = Array.isArray(current.history) ? current.history.slice() : [];
        const previous = history.pop();

        if (!previous) {
          return current;
        }

        return normalizeState({ ...previous, history, updatedAt: Date.now() });
      });
      return;
    }

    const previous = localHistory.pop();
    if (!previous) {
      return;
    }

    state = normalizeState(previous);
    writeLocalState(state);
    renderState();
  }

  // Запускает таймер, сохраняя уже набранное время.
  function startTimer(current) {
    if (current.setEndedPending || current.matchEnded) {
      return current;
    }

    if (!current.timerRunning) {
      current.timerRunning = true;
      current.timerStartedAt = Date.now();
    }

    return current;
  }

  // Ставит таймер на паузу и переносит прошедшее время в elapsedMs.
  function pauseTimer(current) {
    if (current.timerRunning && current.timerStartedAt) {
      current.elapsedMs += Date.now() - current.timerStartedAt;
    }

    current.timerRunning = false;
    current.timerStartedAt = null;
    return current;
  }

  // Сбрасывает таймер партии в 00:00.
  function resetTimer(current) {
    current.timerRunning = false;
    current.timerStartedAt = null;
    current.elapsedMs = 0;
    return current;
  }

  function resetMatch(current) {
    return {
      ...defaultState,
      leftLabel: current.leftLabel,
      rightLabel: current.rightLabel,
      bestOf: current.bestOf,
      autoAdvanceEnabled: current.autoAdvanceEnabled,
      updatedAt: Date.now()
    };
  }

  // Начинает следующий сет: очки и таймер сбрасываются, счет сетов не меняется автоматически.
  function newSet(current) {
    current = clearSetPendingFields(current);
    current = refreshMatchEndFromSets(current);

    if (current.matchEnded) {
      return current;
    }

    current.leftPoints = 0;
    current.rightPoints = 0;
    current.currentSet = Math.min(current.currentSet + 1, current.bestOf);
    current.firstServer = otherSide(current.firstServer);
    return resetTimer(current);
  }

  // Меняет игроков местами вместе с их очками, сетами и начальной подачей.
  function swapSides(current) {
    current = clearAutomationFlags(current);
    [current.leftLabel, current.rightLabel] = [current.rightLabel, current.leftLabel];
    [current.leftPoints, current.rightPoints] = [current.rightPoints, current.leftPoints];
    [current.leftSets, current.rightSets] = [current.rightSets, current.leftSets];
    current.firstServer = otherSide(current.firstServer);
    return refreshMatchEndFromSets(current);
  }

  // Перерисовывает живые данные overlay и control.
  function renderState() {
    const elapsed = getElapsedMs(state);
    const serve = getServeState(state);
    const timerText = formatTime(elapsed);
    const metaText = "BO" + state.bestOf + " • СЕТ " + state.currentSet;

    if (pageType === "overlay") {
      const overlaySnapshot = getOverlaySnapshot(state, serve);
      const canAnimateOverlay = receivedState && previousOverlaySnapshot !== null;

      setText(overlayEls.leftLabel, state.leftLabel);
      setText(overlayEls.rightLabel, state.rightLabel);
      setText(overlayEls.leftPoints, state.leftPoints);
      setText(overlayEls.rightPoints, state.rightPoints);
      setText(overlayEls.leftSets, state.leftSets);
      setText(overlayEls.rightSets, state.rightSets);
      setText(overlayEls.timer, timerText);
      setText(overlayEls.meta, metaText);
      renderServeDots(serve);

      if (canAnimateOverlay) {
        animateOverlayChanges(previousOverlaySnapshot, overlaySnapshot, serve);
      }

      if (receivedState) {
        previousOverlaySnapshot = overlaySnapshot;
      }
    }

    if (isControlPage) {
      setText(controlEls.leftLabel, state.leftLabel);
      setText(controlEls.rightLabel, state.rightLabel);
      setText(controlEls.leftPoints, state.leftPoints);
      setText(controlEls.rightPoints, state.rightPoints);
      setText(controlEls.sets, state.leftSets + " : " + state.rightSets);
      setText(controlEls.timer, timerText);
      setText(controlEls.meta, metaText + " • подача: " + readableSide(serve.server));
      setText(controlEls.status, getMatchStatus(state));

      if (document.activeElement !== controlEls.leftInput) {
        controlEls.leftInput.value = state.leftLabel;
      }

      if (document.activeElement !== controlEls.rightInput) {
        controlEls.rightInput.value = state.rightLabel;
      }

      if (document.activeElement !== controlEls.bestOfSelect) {
        controlEls.bestOfSelect.value = String(state.bestOf);
      }

      if (controlEls.autoAdvanceCheckbox && document.activeElement !== controlEls.autoAdvanceCheckbox) {
        controlEls.autoAdvanceCheckbox.checked = state.autoAdvanceEnabled;
      }

      updateWriteControls();
      syncPendingAutoAdvance();
    }
  }

  // Обновляет два индикатора подачи на каждой стороне.
  function renderServeDots(serve) {
    const dots = {
      left: [overlayEls.leftServe1, overlayEls.leftServe2],
      right: [overlayEls.rightServe1, overlayEls.rightServe2]
    };

    Object.keys(dots).forEach(function (side) {
      dots[side].forEach(function (dot, index) {
        dot.classList.toggle("active", side === serve.server && index === serve.activeDot);
        dot.classList.toggle("hidden", serve.oneServeMode && index === 1);
      });
    });
  }

  // Формирует компактный снимок overlay, чтобы анимации не запускались от таймера или повторного renderState.
  function getOverlaySnapshot(current, serve) {
    return {
      leftPoints: current.leftPoints,
      rightPoints: current.rightPoints,
      leftSets: current.leftSets,
      rightSets: current.rightSets,
      currentSet: current.currentSet,
      serveKey: serve.server + ":" + serve.activeDot + ":" + serve.oneServeMode
    };
  }

  // Запускает микроанимации только для реально изменившихся частей состояния.
  function animateOverlayChanges(previous, current, serve) {
    if (current.leftPoints !== previous.leftPoints) {
      triggerPointAnimation("left", current.leftPoints > previous.leftPoints);
    }

    if (current.rightPoints !== previous.rightPoints) {
      triggerPointAnimation("right", current.rightPoints > previous.rightPoints);
    }

    if (current.leftSets !== previous.leftSets || current.rightSets !== previous.rightSets || current.currentSet !== previous.currentSet) {
      restartAnimation(overlayEls.centerPanel, "set-pulse", 340);
    }

    if (current.serveKey !== previous.serveKey) {
      triggerServeAnimation(serve);
    }
  }

  function triggerPointAnimation(side, isIncrease) {
    const panel = side === "left" ? overlayEls.leftPanel : overlayEls.rightPanel;
    const score = side === "left" ? overlayEls.leftPoints : overlayEls.rightPoints;

    restartAnimation(score, "score-pop", 300);

    if (isIncrease) {
      restartAnimation(panel, "point-pulse", 330);
    }
  }

  function triggerServeAnimation(serve) {
    const dots = serve.server === "left"
      ? [overlayEls.leftServe1, overlayEls.leftServe2]
      : [overlayEls.rightServe1, overlayEls.rightServe2];

    restartAnimation(dots[serve.activeDot], "serve-pop", 260);
  }

  function restartAnimation(element, className, durationMs) {
    if (!element) {
      return;
    }

    element.classList.remove(className);
    void element.offsetWidth;
    element.classList.add(className);
    window.setTimeout(function () {
      element.classList.remove(className);
    }, durationMs);
  }

  // Считает подачу по правилам настольного тенниса: до 10:10 по две, после 10:10 по одной.
  function getServeState(current) {
    const total = current.leftPoints + current.rightPoints;
    const oneServeMode = current.leftPoints >= 10 && current.rightPoints >= 10;
    let server;
    let activeDot;

    if (oneServeMode) {
      server = total % 2 === 0 ? current.firstServer : otherSide(current.firstServer);
      activeDot = 0;
    } else {
      const serveBlock = Math.floor(total / 2);
      server = serveBlock % 2 === 0 ? current.firstServer : otherSide(current.firstServer);
      activeDot = total % 2;
    }

    return { server, activeDot, oneServeMode };
  }

  function changePoints(current, side, delta) {
    if (current.setEndedPending && delta > 0) {
      return null;
    }

    current = clearAutomationFlags(current);
    current[side + "Points"] = clampScore(current[side + "Points"] + delta);
    current = refreshMatchEndFromSets(current);

    if (delta > 0) {
      current = maybeStartSetAutoAdvance(current);
    }

    return current;
  }

  function maybeStartSetAutoAdvance(current) {
    if (!current.autoAdvanceEnabled || current.setEndedPending || current.matchEnded) {
      return current;
    }

    const winner = getSetWinner(current.leftPoints, current.rightPoints);
    if (!winner) {
      return current;
    }

    current.elapsedMs = getElapsedMs(current);
    current.timerRunning = false;
    current.timerStartedAt = null;
    current.setEndedPending = true;
    current.pendingSetWinner = winner;
    current.pendingAutoAdvanceAt = Date.now() + AUTO_ADVANCE_DELAY_MS;
    current.lastSetWinner = winner;
    return current;
  }

  function completePendingAutoAdvance() {
    if (!canWrite() || pendingAutoAdvanceRunning) {
      return;
    }

    pendingAutoAdvanceRunning = true;
    const result = updateMatch(function (current) {
      if (!current.setEndedPending || current.matchEnded) {
        return null;
      }

      if (current.pendingAutoAdvanceAt && Date.now() < current.pendingAutoAdvanceAt) {
        return null;
      }

      const winner = current.pendingSetWinner || getSetWinner(current.leftPoints, current.rightPoints);
      if (!winner) {
        return clearSetPendingFields(current);
      }

      current[winner + "Sets"] = clampScore(current[winner + "Sets"] + 1);
      current.lastSetWinner = winner;
      current = clearSetPendingFields(current);
      current = pauseTimer(current);

      const matchWinner = getMatchWinner(current.leftSets, current.rightSets, current.bestOf);
      if (matchWinner) {
        current.matchEnded = true;
        current.matchWinner = matchWinner;
        current.currentSet = Math.min(current.currentSet, current.bestOf);
        return current;
      }

      current.matchEnded = false;
      current.matchWinner = null;
      current.leftPoints = 0;
      current.rightPoints = 0;
      current.currentSet = Math.min(current.currentSet + 1, current.bestOf);
      current.firstServer = otherSide(current.firstServer);
      return resetTimer(current);
    }, { saveHistory: false });

    if (result && typeof result.finally === "function") {
      result.finally(function () {
        pendingAutoAdvanceRunning = false;
      });
    } else {
      pendingAutoAdvanceRunning = false;
    }
  }

  function syncPendingAutoAdvance() {
    if (!canWrite()) {
      clearPendingAutoAdvanceTimer();
      return;
    }

    if (!state.setEndedPending || !state.pendingSetWinner || !state.pendingAutoAdvanceAt || state.matchEnded) {
      clearPendingAutoAdvanceTimer();
      return;
    }

    if (pendingAutoAdvanceRunning) {
      return;
    }

    const key = state.pendingSetWinner + ":" + state.pendingAutoAdvanceAt;
    if (pendingAutoAdvanceTimer && pendingAutoAdvanceKey === key) {
      return;
    }

    clearPendingAutoAdvanceTimer();
    pendingAutoAdvanceKey = key;
    pendingAutoAdvanceTimer = window.setTimeout(function () {
      pendingAutoAdvanceTimer = null;
      pendingAutoAdvanceKey = null;
      completePendingAutoAdvance();
    }, Math.max(0, state.pendingAutoAdvanceAt - Date.now()));
  }

  function clearPendingAutoAdvanceTimer() {
    if (pendingAutoAdvanceTimer) {
      window.clearTimeout(pendingAutoAdvanceTimer);
    }

    pendingAutoAdvanceTimer = null;
    pendingAutoAdvanceKey = null;
  }

  function clearSetPendingFields(current) {
    current.setEndedPending = false;
    current.pendingSetWinner = null;
    current.pendingAutoAdvanceAt = null;
    return current;
  }

  function clearAutomationFlags(current) {
    current = clearSetPendingFields(current);
    current.matchEnded = false;
    current.matchWinner = null;
    current.lastSetWinner = null;
    return current;
  }

  function refreshMatchEndFromSets(current) {
    const winner = getMatchWinner(current.leftSets, current.rightSets, current.bestOf);
    current.matchEnded = Boolean(winner);
    current.matchWinner = winner;

    if (winner) {
      current.currentSet = Math.min(current.currentSet, current.bestOf);
      current = pauseTimer(current);
    }

    return current;
  }

  function getSetWinner(leftPoints, rightPoints) {
    if (Math.max(leftPoints, rightPoints) < 11 || Math.abs(leftPoints - rightPoints) < 2) {
      return null;
    }

    return leftPoints > rightPoints ? "left" : "right";
  }

  function getMatchWinner(leftSets, rightSets, bestOf) {
    const setsToWin = Math.ceil(normalizeBestOf(bestOf) / 2);
    if (leftSets >= setsToWin) {
      return "left";
    }

    if (rightSets >= setsToWin) {
      return "right";
    }

    return null;
  }

  // Возвращает статус для судьи без записи со стороны overlay.
  function getMatchStatus(current) {
    if (current.matchEnded && current.matchWinner) {
      return "Матч окончен: победила " + readableSideFull(current.matchWinner);
    }

    if (current.setEndedPending) {
      return "Сет окончен, переход через " + AUTO_ADVANCE_SECONDS + " секунды";
    }

    const setWinner = getSetWinner(current.leftPoints, current.rightPoints);
    if (setWinner) {
      return "Сет выиграла " + readableSideFull(setWinner);
    }

    const left = current.leftPoints;
    const right = current.rightPoints;
    const diff = Math.abs(left - right);
    const maxScore = Math.max(left, right);

    if (left >= 10 && right >= 10 && diff === 1) {
      return "Больше " + readableSide(current.leftPoints > current.rightPoints ? "left" : "right");
    }

    if (maxScore >= 10 && diff === 1) {
      return "Сетбол " + readableSide(current.leftPoints > current.rightPoints ? "left" : "right");
    }

    return "Игра идёт";
  }

  // Держит таймер на экране живым между обновлениями Firebase.
  function startRenderLoop() {
    if (timerFrame) {
      window.cancelAnimationFrame(timerFrame);
    }

    const tick = function () {
      renderState();
      timerFrame = window.requestAnimationFrame(tick);
    };

    tick();
  }

  function normalizeState(value) {
    const merged = { ...defaultState, ...(value || {}) };
    merged.leftLabel = cleanLabel(merged.leftLabel, defaultState.leftLabel);
    merged.rightLabel = cleanLabel(merged.rightLabel, defaultState.rightLabel);
    merged.leftPoints = clampScore(Number(merged.leftPoints));
    merged.rightPoints = clampScore(Number(merged.rightPoints));
    merged.leftSets = clampScore(Number(merged.leftSets));
    merged.rightSets = clampScore(Number(merged.rightSets));
    merged.bestOf = normalizeBestOf(merged.bestOf);
    merged.currentSet = Math.min(Math.max(1, Number(merged.currentSet) || 1), merged.bestOf);
    merged.firstServer = merged.firstServer === "right" ? "right" : "left";
    merged.autoAdvanceEnabled = merged.autoAdvanceEnabled !== false;
    merged.setEndedPending = Boolean(merged.setEndedPending);
    merged.matchWinner = normalizeSideOrNull(merged.matchWinner);
    merged.lastSetWinner = normalizeSideOrNull(merged.lastSetWinner);
    merged.pendingSetWinner = normalizeSideOrNull(merged.pendingSetWinner);
    merged.pendingAutoAdvanceAt = merged.pendingAutoAdvanceAt ? Number(merged.pendingAutoAdvanceAt) : null;
    merged.matchEnded = Boolean(merged.matchEnded && merged.matchWinner);

    if (!merged.setEndedPending) {
      merged.pendingSetWinner = null;
      merged.pendingAutoAdvanceAt = null;
    }

    merged.elapsedMs = Math.max(0, Number(merged.elapsedMs) || 0);
    merged.timerRunning = Boolean(merged.timerRunning);
    merged.timerStartedAt = merged.timerStartedAt ? Number(merged.timerStartedAt) : null;
    merged.updatedAt = Number(merged.updatedAt) || Date.now();
    return merged;
  }

  function cleanLabel(value, fallback) {
    const label = String(value || "").trim();
    return label ? label.slice(0, 24).toUpperCase() : fallback;
  }

  function getElapsedMs(current) {
    if (current.timerRunning && current.timerStartedAt) {
      return current.elapsedMs + Math.max(0, Date.now() - current.timerStartedAt);
    }

    return current.elapsedMs;
  }

  function formatTime(ms) {
    const totalSeconds = Math.floor(ms / 1000);
    const minutes = String(Math.floor(totalSeconds / 60)).padStart(2, "0");
    const seconds = String(totalSeconds % 60).padStart(2, "0");
    return minutes + ":" + seconds;
  }

  function clampScore(value) {
    return Math.max(0, Number.isFinite(value) ? value : 0);
  }

  function normalizeBestOf(value) {
    return Number(value) === 5 ? 5 : 3;
  }

  function otherSide(side) {
    return side === "left" ? "right" : "left";
  }

  function normalizeSideOrNull(side) {
    return side === "left" || side === "right" ? side : null;
  }

  function readableSide(side) {
    return side === "left" ? "слева" : "справа";
  }

  function readableSideFull(side) {
    return side === "left" ? "левая сторона" : "правая сторона";
  }

  function setText(element, value) {
    if (element) {
      element.textContent = value;
    }
  }

  function setConnectionStatus(text, mode) {
    if (!controlEls.connection) {
      return;
    }

    controlEls.connection.textContent = text;
    controlEls.connection.classList.toggle("online", mode === "online");
    controlEls.connection.classList.toggle("offline", mode === "offline");
  }

  function readLocalState() {
    try {
      return JSON.parse(window.localStorage.getItem(localStorageKey)) || defaultState;
    } catch (error) {
      return defaultState;
    }
  }

  function writeLocalState(nextState) {
    window.localStorage.setItem(localStorageKey, JSON.stringify(stripHistory(nextState)));
  }

  function stripHistory(value) {
    const clone = { ...value };
    delete clone.history;
    return clone;
  }
})();

