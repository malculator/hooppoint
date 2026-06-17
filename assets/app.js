import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

// Supabase project credentials
const SUPABASE_URL = "https://tnljltwhstwqocjywnpp.supabase.co"
const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_i4gHTmzPaGzUajXTeHWdzA_vx1WqFUI"

// Create client
const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY)

async function checkAuth() {
  try {
    const { data: { user } } = await supabase.auth.getUser();
    if (user) {
      setAccountButtonLabel(user);
      showApp();
      const workspaceIds = await loadWorkspaceIds(user.id);
      subscribeToAccessibleGames(user.id, workspaceIds);
      subscribeToWorkspaceMemberships(user.id);
      return user;
    }
  } catch (err) {
    console.error('Error checking auth:', err);
  }
  showSignIn();
  return null;
}

function setAuthHeaderVisibility(isSignedIn) {
  const authActions = document.querySelector('.auth-actions');
  if (!authActions) return;
  authActions.classList.toggle('auth-hidden', !isSignedIn);
}

function setAccountButtonLabel(user) {
  const accountButton = document.querySelector('[data-action="open-account-menu"]');
  if (!accountButton) return;

  const displayName =
    user?.user_metadata?.full_name ||
    user?.user_metadata?.name ||
    user?.user_metadata?.display_name ||
    user?.email ||
    'Account';

  accountButton.textContent = String(displayName);
}

function showSignIn() {
  document.getElementById('signin-container').style.display = 'flex';
  document.getElementById('app-content').style.display = 'none';
  closeModal('game-setup-modal');
  setAuthHeaderVisibility(false);
}

function showApp() {
  document.getElementById('signin-container').style.display = 'none';
  document.getElementById('app-content').style.display = '';
  setAuthHeaderVisibility(true);
}

async function signOut() {
  try {
    const { error } = await supabase.auth.signOut();
    if (error) throw error;
    console.log('Signed out');
    resetCurrentGameState();
    showSignIn();
  } catch (err) {
    console.error('Sign out error:', err);
  }
}

async function signIn(email, password) {
  try {
    const { data, error } = await supabase.auth.signInWithPassword({
      email: email,
      password: password
    });
    if (error) throw error;
    console.log('Signed in:', data.user.email);
    setAccountButtonLabel(data.user);
    showApp();
    await showGamePicker();
  } catch (err) {
    console.error('Sign in error:', err);
    document.getElementById('signin-error').textContent = err.message;
  }
}

// Expose signIn, signOut, and supabase for inline onclick handlers and config script when app.js loads as a module.
window.signIn = signIn;
window.signOut = signOut;
window.supabase = supabase;

const gameState = {
  gameId: null,
  status: null,
  score: {
    home: 0,
    away: 0
  },
  fouls: {
    home: 0,
    away: 0
  },
  timeouts: {
    home: 0,
    away: 0
  },
  homeTeamName: 'Team 1',
  awayTeamName: 'Team 2',
  gameName: '',
  events: [],
  currentTeam: 'home', // Default to home, can be toggled
  clock: {
    minutes: 0,
    seconds: 0,
    tenths: 0,
    running: false
  },
  shotClock: {
    time: 24, // NBA shot clock
    running: false
  }
};

const eventTemplateCache = new Map();

async function loadHTML(id, path) {
  try {
    const res = await fetch(path, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP error! ${res.status}`);
    const html = await res.text();
    const container = document.getElementById(id);
    if (container) {
      container.innerHTML = html;
    } else {
      console.warn(`No element with id="${id}" found`);
    }
  } catch (err) {
    console.error(`Failed to load ${path}:`, err);
  }
}

async function getEventTemplate(eventType) {
  const normalizedType = String(eventType || '').toLowerCase();
  if (eventTemplateCache.has(normalizedType)) {
    return eventTemplateCache.get(normalizedType);
  }

  const path = `/assets/templates/events/${normalizedType}.html`;

  try {
    const res = await fetch(path, { cache: 'no-cache' });
    if (!res.ok) {
      throw new Error(`Template not found: ${path}`);
    }

    const html = await res.text();
    eventTemplateCache.set(normalizedType, html);
    return html;
  } catch (err) {
    console.warn(`Unable to load event template for '${normalizedType}':`, err);
    eventTemplateCache.set(normalizedType, null);
    return null;
  }
}

function formatEventTimestamp(period, seconds) {
  const mins = Math.floor(Number(seconds ?? 0) / 60);
  const secs = Number(seconds ?? 0) % 60;
  return `Q${Number(period ?? 0)} ${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

function getEventTeamLabel(teamSide) {
  return teamSide === 'away' ? 'Team 2' : 'Team 1';
}

function getEventNameText(event) {
  if (event.event_name) {
    const text = String(event.event_name).trim();
    return text.replace(/^[a-z]/, match => match.toUpperCase());
  }
  return event.event_type ? event.event_type.toUpperCase() : 'EVENT';
}

function compareGameEvents(a, b) {
  const periodA = Number(a.period ?? 0);
  const periodB = Number(b.period ?? 0);
  if (periodA !== periodB) return periodA - periodB;

  const timeA = Number(a.time_seconds ?? 0);
  const timeB = Number(b.time_seconds ?? 0);
  if (timeA !== timeB) return timeB - timeA;

  const createdA = new Date(a.created_at).getTime();
  const createdB = new Date(b.created_at).getTime();
  return createdA - createdB;
}

function hydrateEventText(event, rootElement) {
  if (!rootElement) return;

  const typeEl = rootElement.querySelector('.event-item.type');
  const teamEl = rootElement.querySelector('.event-item.team');
  const playerEl = rootElement.querySelector('.event-item.player');
  const timeEl = rootElement.querySelector('.event-item.timestamp');

  if (typeEl) {
    typeEl.textContent = getEventNameText(event);
  }
  if (teamEl) {
    teamEl.textContent = getEventTeamLabel(event.team_side);
  }
  if (playerEl) {
    playerEl.textContent = String(event.player_number ?? '');
  }
  if (timeEl) {
    timeEl.textContent = formatEventTimestamp(event.period, event.time_seconds);
  }
}

async function inlineSVGs() {
  const placeholders = document.querySelectorAll("[data-inline-svg]");
  for (const el of placeholders) {
    const key = el.dataset.inlineSvg;
    const response = await fetch(`/assets/images/app-icons/${key}.svg`);
    const svgText = await response.text();
    el.outerHTML = svgText;
  }
}

async function createGame(workspaceId, homeTeam, awayTeam, team1Color, team2Color, gameName = null) {
  const { data: userData } = await supabase.auth.getUser();
  const { data, error } = await supabase
    .from("games")
    .insert({
      workspace_id: workspaceId,
      created_by: userData.user.id,
      home_team: homeTeam,
      away_team: awayTeam,
      game_name: gameName || null,
      metadata: {
        team1Color,
        team2Color
      },
      status: 'In Progress'
    })
    .select()
    .single();
  if (error) console.error(error);
  return data;
}

async function initGame(gameId) {
  if (!gameId) {
    console.log('No gameId available');
    await showGamePicker();
    return;
  }

  gameState.gameId = gameId;

  try {
    // Load game info (including status and team names)
    const { data: gameData, error: gameError } = await supabase
      .from("games")
      .select("status,home_team,away_team,game_name")
      .eq("id", gameId)
      .single();

    if (gameError) throw gameError;

    gameState.status = gameData.status;
    gameState.homeTeamName = gameData.home_team || 'Team 1';
    gameState.awayTeamName = gameData.away_team || 'Team 2';
    gameState.gameName = gameData.game_name || '';
    updateStatusDisplay();
    updateTeamNames();
    updateGameName();

    // Load persisted scoreboard/fouls/timeouts from game_data
    try {
      console.log('initGame: loading game_data for', gameId);
      const { data: gd, error: gdError } = await supabase
        .from('game_data')
        .select('home_points,away_points,home_fouls,away_fouls,home_timeouts,away_timeouts,updated_at')
        .eq('game_id', gameId)
        .maybeSingle();

      console.log('initGame: game_data response', { gd, gdError });
      if (gdError) {
        console.error('Error loading game_data:', gdError);
      } else if (gd) {
        gameState.score.home = gd.home_points || 0;
        gameState.score.away = gd.away_points || 0;
        gameState.fouls.home = gd.home_fouls || 0;
        gameState.fouls.away = gd.away_fouls || 0;
        gameState.timeouts.home = gd.home_timeouts || 0;
        gameState.timeouts.away = gd.away_timeouts || 0;

        console.log('initGame: applied game_data to gameState', {
          score: gameState.score,
          fouls: gameState.fouls,
          timeouts: gameState.timeouts
        });

        // Update UI elements if present
        const t1Score = document.getElementById('team-1-score');
        const t2Score = document.getElementById('team-2-score');
        const t1Fouls = document.getElementById('team-1-fouls');
        const t2Fouls = document.getElementById('team-2-fouls');
        const t1Timeouts = document.getElementById('team-1-timeouts');
        const t2Timeouts = document.getElementById('team-2-timeouts');

        console.log('initGame: DOM elements', {
          t1Score,
          t2Score,
          t1Fouls,
          t2Fouls,
          t1Timeouts,
          t2Timeouts
        });

        if (t1Score) t1Score.textContent = String(gameState.score.home);
        if (t2Score) t2Score.textContent = String(gameState.score.away);
        if (t1Fouls) t1Fouls.textContent = String(gameState.fouls.home);
        if (t2Fouls) t2Fouls.textContent = String(gameState.fouls.away);
        if (t1Timeouts) t1Timeouts.textContent = String(gameState.timeouts.home);
        if (t2Timeouts) t2Timeouts.textContent = String(gameState.timeouts.away);

        console.log('initGame: DOM updated from game_data');
      } else {
        console.log('initGame: no game_data row for', gameId);
      }
    } catch (err) {
      console.error('Failed to load or apply game_data:', err);
    }

    // Load events
    const { data, error } = await supabase
      .from("game_events")
      .select("*")
      .eq("game_id", gameId)
      .order('period', { ascending: true })
      .order('time_seconds', { ascending: false })
      .order('created_at', { ascending: true });

    if (error) throw error;

    data.forEach(applyEvent);

    cleanupGameSpecificSubscriptions();
    await subscribeToGameEvents();
    subscribeToGameStatus();
    subscribeToGameData();
    renderEvents().catch(console.error); // Render loaded events

    closeModal('game-setup-modal');
  } catch (err) {
    console.error('Error initializing game:', err);
  }
}

async function startGame(gameId) {
  try {
    const { error } = await supabase
      .from("games")
      .update({ status: "live" })
      .eq("id", gameId);

    if (error) throw error;
    console.log(`Game ${gameId} started`);
  } catch (err) {
    console.error('Error starting game:', err);
  }
}

async function finishGame(gameId) {
  try {
    const { error } = await supabase
      .from("games")
      .update({ status: "finished" })
      .eq("id", gameId);

    if (error) throw error;
    console.log(`Game ${gameId} finished`);
  } catch (err) {
    console.error('Error finishing game:', err);
  }
}

function applyEvent(event) {
  try {
    gameState.events.push(event);

    if (event.event_type === "shot") {
      gameState.score[event.team_side] += event.metadata.points;
      resetShotClock(); // Reset shot clock on shot
    }

    if (event.event_type === "foul") {
      gameState.fouls[event.team_side] += 1;
      resetShotClock(); // Reset on foul
    }

    // Reset shot clock on rebound, turnover, etc. if desired
    if (['rebound', 'turnover'].includes(event.event_type)) {
      resetShotClock();
    }

    renderScoreboard();
    renderEvents().catch(console.error);
  } catch (err) {
    console.error('Error applying event:', err);
  }
}

async function recordEvent(event) {
  try {
    if (!gameState.gameId || gameState.status !== 'live') {
      console.warn('Cannot record event: game not active');
      return;
    }

    const { error } = await supabase
      .from("game_events")
      .insert({
        game_id: gameState.gameId,
        event_type: event.event_type,
        team_side: event.team_side,
        metadata: event.metadata
      });

    if (error) throw error;
    console.log(`Event recorded: ${event.event_type} for ${event.team_side}`);
  } catch (err) {
    console.error('Error recording event:', err);
    // Optionally show user error
    alert('Failed to record event. Please try again.');
  }
}

function updateStatusDisplay() {
  try {
    const el = document.getElementById("gameStatus");
    if (!el) return;

    el.textContent = gameState.status ? gameState.status.toUpperCase() : 'UNKNOWN';
  } catch (err) {
    console.error('Error updating status display:', err);
  }
}

function updateGameName() {
  try {
    const el = document.getElementById('game-name');
    if (!el) return;

    if (gameState.gameName) {
      el.textContent = gameState.gameName;
      return;
    }

    if (gameState.homeTeamName && gameState.awayTeamName) {
      el.textContent = `${gameState.homeTeamName} vs ${gameState.awayTeamName}`;
      return;
    }

    el.textContent = 'No Game Loaded';
  } catch (err) {
    console.error('Error updating game name:', err);
  }
}

function updateTeamNames() {
  try {
    const homeNameEl = document.getElementById('team-1-name');
    const awayNameEl = document.getElementById('team-2-name');
    if (homeNameEl) homeNameEl.textContent = gameState.homeTeamName || 'Team 1';
    if (awayNameEl) awayNameEl.textContent = gameState.awayTeamName || 'Team 2';
  } catch (err) {
    console.error('Error updating team names:', err);
  }
}

function rebuildEventDerivedState() {
  gameState.score.home = 0;
  gameState.score.away = 0;
  gameState.fouls.home = 0;
  gameState.fouls.away = 0;

  for (const event of gameState.events) {
    if (event.event_type === 'shot') {
      const points = Number(event.metadata?.points ?? 0);
      if (event.team_side === 'home') gameState.score.home += points;
      if (event.team_side === 'away') gameState.score.away += points;
    }
    if (event.event_type === 'foul') {
      if (event.team_side === 'home') gameState.fouls.home += 1;
      if (event.team_side === 'away') gameState.fouls.away += 1;
    }
  }

  renderScoreboard();
}

function renderScoreboard() {
  try {
    document.getElementById("team-1-score").textContent = gameState.score.home;
    document.getElementById("team-2-score").textContent = gameState.score.away;
    document.getElementById("team-1-fouls").textContent = gameState.fouls.home;
    document.getElementById("team-2-fouls").textContent = gameState.fouls.away;
  } catch (err) {
    console.error('Error rendering scoreboard:', err);
  }
}

let gameEventsChannel;
let gameStatusChannel;
let gameDataChannel;
let createdGamesChannel;
let workspaceGamesChannel;
let membershipChannel;

function unsubscribeChannel(channel) {
  if (!channel) return;
  try {
    channel.unsubscribe();
  } catch (err) {
    console.error('Error unsubscribing channel:', err);
  }
}

async function refreshGameEvents() {
  try {
    const { data, error } = await supabase
      .from('game_events')
      .select('*')
      .eq('game_id', gameState.gameId)
      .order('period', { ascending: true })
      .order('time_seconds', { ascending: false })
      .order('created_at', { ascending: true });

    if (error) throw error;
    gameState.events = data || [];
    rebuildEventDerivedState();
    await renderEvents();
  } catch (err) {
    console.error('Error refreshing game events:', err);
  }
}

async function subscribeToGameEvents() {
  try {
    unsubscribeChannel(gameEventsChannel);
    gameEventsChannel = supabase
      .channel(`game-events-${gameState.gameId}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "game_events",
          filter: `game_id=eq.${gameState.gameId}`
        },
        (payload) => {
          applyEvent(payload.new);
        }
      )
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "game_events",
          filter: `game_id=eq.${gameState.gameId}`
        },
        () => {
          refreshGameEvents();
        }
      )
      .on(
        "postgres_changes",
        {
          event: "DELETE",
          schema: "public",
          table: "game_events",
          filter: `game_id=eq.${gameState.gameId}`
        },
        () => {
          refreshGameEvents();
        }
      )
      .subscribe();
    console.log('Subscribed to real-time game events');
  } catch (err) {
    console.error('Error subscribing to real-time game events:', err);
  }
}

function subscribeToGameStatus() {
  try {
    unsubscribeChannel(gameStatusChannel);
    gameStatusChannel = supabase
      .channel(`game-status-${gameState.gameId}`)
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "games",
          filter: `id=eq.${gameState.gameId}`
        },
        (payload) => {
          gameState.status = payload.new.status;
          updateStatusDisplay();

          if (payload.new.status === 'live') {
            startShotClock();
          } else if (payload.new.status === 'finished') {
            stopShotClock();
            stopClock();
          }
        }
      )
      .subscribe();
    console.log('Subscribed to game status');
  } catch (err) {
    console.error('Error subscribing to game status:', err);
  }
}

function subscribeToGameData() {
  try {
    unsubscribeChannel(gameDataChannel);
    gameDataChannel = supabase
      .channel(`game-data-${gameState.gameId}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "game_data",
          filter: `game_id=eq.${gameState.gameId}`
        },
        (payload) => {
          applyGameData(payload.new);
        }
      )
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "game_data",
          filter: `game_id=eq.${gameState.gameId}`
        },
        (payload) => {
          applyGameData(payload.new);
        }
      )
      .on(
        "postgres_changes",
        {
          event: "DELETE",
          schema: "public",
          table: "game_data",
          filter: `game_id=eq.${gameState.gameId}`
        },
        () => {
          resetGameDataState();
        }
      )
      .subscribe();
    console.log('Subscribed to game_data');
  } catch (err) {
    console.error('Error subscribing to game_data:', err);
  }
}

async function loadWorkspaceIds(userId) {
  try {
    const { data, error } = await supabase
      .from('workspace_members')
      .select('workspace_id')
      .eq('user_id', userId);
    if (error) throw error;
    return data?.map(m => m.workspace_id) || [];
  } catch (err) {
    console.error('Error loading workspace ids:', err);
    return [];
  }
}

async function refreshAccessibleGameList() {
  const listElement = document.getElementById('game-list');
  if (!listElement) return;
  const games = await loadUserGames();
  renderUserGames(games);
}

function subscribeToAccessibleGames(userId, workspaceIds) {
  try {
    unsubscribeChannel(createdGamesChannel);
    unsubscribeChannel(workspaceGamesChannel);

    createdGamesChannel = supabase
      .channel(`games-created-${userId}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "games",
          filter: `created_by=eq.${userId}`
        },
        refreshAccessibleGameList
      )
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "games",
          filter: `created_by=eq.${userId}`
        },
        refreshAccessibleGameList
      )
      .on(
        "postgres_changes",
        {
          event: "DELETE",
          schema: "public",
          table: "games",
          filter: `created_by=eq.${userId}`
        },
        refreshAccessibleGameList
      )
      .subscribe();

    if (workspaceIds.length > 0) {
      workspaceGamesChannel = supabase
        .channel(`games-workspace-${userId}`)
        .on(
          "postgres_changes",
          {
            event: "INSERT",
            schema: "public",
            table: "games",
            filter: `workspace_id=in.(${workspaceIds.join(',')})`
          },
          refreshAccessibleGameList
        )
        .on(
          "postgres_changes",
          {
            event: "UPDATE",
            schema: "public",
            table: "games",
            filter: `workspace_id=in.(${workspaceIds.join(',')})`
          },
          refreshAccessibleGameList
        )
        .on(
          "postgres_changes",
          {
            event: "DELETE",
            schema: "public",
            table: "games",
            filter: `workspace_id=in.(${workspaceIds.join(',')})`
          },
          refreshAccessibleGameList
        )
        .subscribe();
    }

    console.log('Subscribed to accessible games');
  } catch (err) {
    console.error('Error subscribing to accessible games:', err);
  }
}

function subscribeToWorkspaceMemberships(userId) {
  try {
    unsubscribeChannel(membershipChannel);
    membershipChannel = supabase
      .channel(`workspace-members-${userId}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "workspace_members",
          filter: `user_id=eq.${userId}`
        },
        async () => {
          const workspaceIds = await loadWorkspaceIds(userId);
          subscribeToAccessibleGames(userId, workspaceIds);
          refreshAccessibleGameList();
        }
      )
      .on(
        "postgres_changes",
        {
          event: "DELETE",
          schema: "public",
          table: "workspace_members",
          filter: `user_id=eq.${userId}`
        },
        async () => {
          const workspaceIds = await loadWorkspaceIds(userId);
          subscribeToAccessibleGames(userId, workspaceIds);
          refreshAccessibleGameList();
        }
      )
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "workspace_members",
          filter: `user_id=eq.${userId}`
        },
        async () => {
          const workspaceIds = await loadWorkspaceIds(userId);
          subscribeToAccessibleGames(userId, workspaceIds);
          refreshAccessibleGameList();
        }
      )
      .subscribe();
    console.log('Subscribed to workspace memberships');
  } catch (err) {
    console.error('Error subscribing to workspace memberships:', err);
  }
}

function cleanupGameSpecificSubscriptions() {
  unsubscribeChannel(gameEventsChannel);
  unsubscribeChannel(gameStatusChannel);
  unsubscribeChannel(gameDataChannel);
}

function cleanupListSubscriptions() {
  unsubscribeChannel(createdGamesChannel);
  unsubscribeChannel(workspaceGamesChannel);
}

function cleanupAllRealtimeSubscriptions() {
  cleanupGameSpecificSubscriptions();
  cleanupListSubscriptions();
  unsubscribeChannel(membershipChannel);
}

function applyGameData(data) {
  try {
    console.log('applyGameData: payload', data);
    gameState.score.home = data.home_points || 0;
    gameState.score.away = data.away_points || 0;
    gameState.fouls.home = data.home_fouls || 0;
    gameState.fouls.away = data.away_fouls || 0;
    gameState.timeouts.home = data.home_timeouts || 0;
    gameState.timeouts.away = data.away_timeouts || 0;

    console.log('applyGameData: updated gameState', {
      score: gameState.score,
      fouls: gameState.fouls,
      timeouts: gameState.timeouts
    });

    renderScoreboard();
    const t1Timeouts = document.getElementById('team-1-timeouts');
    const t2Timeouts = document.getElementById('team-2-timeouts');
    console.log('applyGameData: timeout DOM nodes', { t1Timeouts, t2Timeouts });
    if (t1Timeouts) t1Timeouts.textContent = String(gameState.timeouts.home);
    if (t2Timeouts) t2Timeouts.textContent = String(gameState.timeouts.away);
    console.log('applyGameData: DOM updated');
  } catch (err) {
    console.error('Error applying game_data:', err);
  }
}

function resetGameDataState() {
  gameState.score.home = 0;
  gameState.score.away = 0;
  gameState.fouls.home = 0;
  gameState.fouls.away = 0;
  gameState.timeouts.home = 0;
  gameState.timeouts.away = 0;
  renderScoreboard();
  const t1Timeouts = document.getElementById('team-1-timeouts');
  const t2Timeouts = document.getElementById('team-2-timeouts');
  if (t1Timeouts) t1Timeouts.textContent = '0';
  if (t2Timeouts) t2Timeouts.textContent = '0';
}

function resetCurrentGameState() {
  cleanupGameSpecificSubscriptions();

  gameState.gameId = null;
  gameState.status = null;
  gameState.score.home = 0;
  gameState.score.away = 0;
  gameState.fouls.home = 0;
  gameState.fouls.away = 0;
  gameState.timeouts.home = 0;
  gameState.timeouts.away = 0;
  gameState.events = [];
  gameState.currentTeam = 'home';
  gameState.homeTeamName = 'Team 1';
  gameState.awayTeamName = 'Team 2';
  gameState.gameName = '';

  resetClock();
  resetShotClock();
  resetGameDataState();
  updateStatusDisplay();
  updateTeamNames();
  updateGameName();
  renderEvents();
}

// Clock functions
function updateClockDisplay() {
  try {
    document.getElementById("clock-minutes").textContent = gameState.clock.minutes.toString().padStart(2, '0');
    document.getElementById("clock-seconds").textContent = gameState.clock.seconds.toString().padStart(2, '0');
    document.getElementById("clock-tenths").textContent = gameState.clock.tenths;
  } catch (err) {
    console.error('Error updating clock display:', err);
  }
}

function startClock() {
  if (gameState.clock.running) return;
  gameState.clock.running = true;
  gameState.clock.interval = setInterval(() => {
    gameState.clock.tenths++;
    if (gameState.clock.tenths >= 10) {
      gameState.clock.tenths = 0;
      gameState.clock.seconds++;
      if (gameState.clock.seconds >= 60) {
        gameState.clock.seconds = 0;
        gameState.clock.minutes++;
      }
    }
    updateClockDisplay();
  }, 100);
}

function stopClock() {
  gameState.clock.running = false;
  if (gameState.clock.interval) {
    clearInterval(gameState.clock.interval);
    gameState.clock.interval = null;
  }
}

function resetClock() {
  stopClock();
  gameState.clock.minutes = 0;
  gameState.clock.seconds = 0;
  gameState.clock.tenths = 0;
  updateClockDisplay();
}

function toggleTeam() {
  try {
    gameState.currentTeam = gameState.currentTeam === 'home' ? 'away' : 'home';
    // Update UI to show current team, e.g., highlight team box
    document.getElementById("team-1-box").classList.toggle('active', gameState.currentTeam === 'home');
    document.getElementById("team-2-box").classList.toggle('active', gameState.currentTeam === 'away');
  } catch (err) {
    console.error('Error toggling team:', err);
  }
}

// Shot clock functions
function updateShotClockDisplay() {
  try {
    const el = document.getElementById("shot-clock");
    if (el) {
      el.textContent = gameState.shotClock.time.toString().padStart(2, '0');
    }
  } catch (err) {
    console.error('Error updating shot clock display:', err);
  }
}

function startShotClock() {
  if (gameState.shotClock.running) return;
  gameState.shotClock.running = true;
  gameState.shotClock.interval = setInterval(() => {
    if (gameState.shotClock.time > 0) {
      gameState.shotClock.time--;
      updateShotClockDisplay();
    } else {
      stopShotClock();
      // Handle shot clock violation (e.g., alert or record event)
      console.log("Shot clock violation!");
    }
  }, 1000);
}

function stopShotClock() {
  gameState.shotClock.running = false;
  if (gameState.shotClock.interval) {
    clearInterval(gameState.shotClock.interval);
    gameState.shotClock.interval = null;
  }
}

function resetShotClock(time = 24) {
  stopShotClock();
  gameState.shotClock.time = time;
  updateShotClockDisplay();
}

async function renderEvents() {
  try {
    const container = document.getElementById('events');
    if (!container) return;

    container.innerHTML = '';

    if (!gameState.events?.length) {
      return;
    }

    const sortedEvents = [...gameState.events].sort(compareGameEvents);

    for (const event of sortedEvents) {
      const templateHtml = await getEventTemplate(event.event_type);
      let eventElement;

      if (templateHtml) {
        const parser = new DOMParser();
        const doc = parser.parseFromString(templateHtml, 'text/html');
        eventElement = doc.querySelector('.event');
      }

      if (!eventElement || !(eventElement instanceof HTMLElement)) {
        eventElement = document.createElement('div');
        eventElement.className = `event ${event.event_type} dynamic`;

        const typeItem = document.createElement('div');
        typeItem.className = 'event-item type';
        const teamItem = document.createElement('div');
        teamItem.className = 'event-item team';
        const playerItem = document.createElement('div');
        playerItem.className = 'event-item player';
        const timestampItem = document.createElement('div');
        timestampItem.className = 'event-item timestamp';

        eventElement.appendChild(typeItem);
        eventElement.appendChild(teamItem);
        eventElement.appendChild(playerItem);
        eventElement.appendChild(timestampItem);
      }

      eventElement.classList.add('dynamic');
      hydrateEventText(event, eventElement);
      container.appendChild(eventElement);
    }

    await inlineSVGs();
  } catch (err) {
    console.error('Error rendering events:', err);
  }
}








function openPopup(popupId) {
  var popup = document.getElementById(popupId);
  if (popup) {
    popup.style.display = "flex";
  }
}

function closePopup(popupId) {
  var popup = document.getElementById(popupId);
  if (popup) {
    popup.style.display = "none";
  }
}

function openModal(modalId) {
  const modal = document.getElementById(modalId);
  if (modal) {
    modal.style.display = 'flex';
  }
}

function closeModal(modalId) {
  const modal = document.getElementById(modalId);
  if (modal) {
    modal.style.display = 'none';
  }
}

function switchSetupView(viewName) {
  const setupBox = document.getElementById('game-setup-box');
  if (!setupBox) return;
  const currentView = setupBox.querySelector('.modal-view:not(.hidden)');
  const nextView = setupBox.querySelector(`.modal-view[data-view="${viewName}"]`);
  if (!nextView || currentView === nextView) return;

  setupBox.classList.add('transitioning');
  if (currentView) {
    currentView.classList.add('hidden');
  }

  nextView.classList.remove('hidden');
  setTimeout(() => setupBox.classList.remove('transitioning'), 260);
}

function openSetupModal(viewName) {
  openModal('game-setup-modal');
  switchSetupView(viewName);
}

async function loadUserGames() {
  try {
    const { data: userData } = await supabase.auth.getUser();
    const userId = userData?.user?.id;
    if (!userId) return [];

    // Get workspaces the user is a member of
    const { data: membershipData, error: membershipError } = await supabase
      .from('workspace_members')
      .select('workspace_id')
      .eq('user_id', userId);

    if (membershipError) console.error('Error loading workspace memberships:', membershipError);
    const workspaceIds = membershipData?.map(m => m.workspace_id) || [];

    // Build filter: created_by = userId OR workspace_id in user's workspaces
    let query = supabase
      .from('games')
      .select('id,home_team,away_team,game_name,status,starts_at')
      .order('starts_at', { ascending: false, nullsFirst: false });

    // Use OR filter to get games by created_by or workspace_id
    if (workspaceIds.length > 0) {
      query = query.or(`created_by.eq.${userId},workspace_id.in.(${workspaceIds.join(',')})`)
    } else {
      query = query.eq('created_by', userId);
    }

    const { data, error } = await query;

    if (error) throw error;
    return data || [];
  } catch (err) {
    console.error('Error loading user games:', err);
    return [];
  }
}

function renderUserGames(games) {
  const list = document.getElementById('game-list');
  const message = document.getElementById('no-games-message');
  if (!list || !message) return;
  list.innerHTML = '';

  if (!games || games.length === 0) {
    message.style.display = 'block';
    return;
  }

  message.style.display = 'none';
  games.forEach(game => {
    // Build game name: prefer explicit game_name, else fallback to home vs away or timestamp
    let gameName = game.game_name || 'My Game';
    if (!game.game_name && game.home_team && game.away_team) {
      gameName = `${game.home_team} vs ${game.away_team}`;
    } else if (!game.game_name && game.starts_at) {
      gameName = `My Game ${game.starts_at}`;
    }

    const li = document.createElement('li');
    const button = document.createElement('button');
    
    const nameDiv = document.createElement('div');
    nameDiv.className = 'game-name';
    nameDiv.textContent = gameName;
    
    const statusDiv = document.createElement('div');
    statusDiv.className = 'game-status';
    statusDiv.textContent = game.status || 'unknown';
    
    const timeDiv = document.createElement('div');
    timeDiv.className = 'game-time';
    timeDiv.textContent = game.starts_at || 'No time set';
    
    button.appendChild(nameDiv);
    button.appendChild(statusDiv);
    button.appendChild(timeDiv);
    
    button.addEventListener('click', async () => {
      await selectGame(game.id);
    });
    
    li.appendChild(button);
    list.appendChild(li);
  });
}

async function showGamePicker() {
  cleanupGameSpecificSubscriptions();
  const games = await loadUserGames();
  renderUserGames(games);
  openSetupModal('picker');

  const closePickerBtn = document.getElementById('close-game-picker');
  if (closePickerBtn) {
    closePickerBtn.disabled = !gameState.gameId;
  }
}

async function selectGame(gameId) {
  try {
    // Check if starts_at is null, and if so, set it to current timestamp
    const { data: gameData, error: fetchError } = await supabase
      .from('games')
      .select('starts_at,status')
      .eq('id', gameId)
      .single();

    if (fetchError) throw fetchError;

    if (!gameData.starts_at) {
      const now = new Date().toISOString();
      const { error: updateError } = await supabase
        .from('games')
        .update({ starts_at: now })
        .eq('id', gameId);

      if (updateError) throw updateError;
    }
    // If the game is scheduled, mark it In Progress when selecting
    if (gameData.status === 'Scheduled') {
      const { error: statusError } = await supabase
        .from('games')
        .update({ status: 'In Progress' })
        .eq('id', gameId);
      if (statusError) console.error('Failed to update status to In Progress:', statusError);
    }
  } catch (err) {
    console.error('Error setting game start time:', err);
  }

  const params = new URLSearchParams(window.location.search);
  params.set('game', gameId);
  window.history.replaceState({}, '', `${window.location.pathname}?${params.toString()}`);

  resetCurrentGameState();
  await initGame(gameId);
}

async function handleCreateGame(event) {
  event.preventDefault();
  const createBtn = document.getElementById('createBtn');
  const errorDiv = document.getElementById('modal-error');
  if (!createBtn || !errorDiv) return;

  createBtn.disabled = true;
  errorDiv.textContent = '';

  const team1Name = document.getElementById('team1Name').value;
  const team1Color = document.getElementById('team1Color').value;
  const team2Name = document.getElementById('team2Name').value;
  const team2Color = document.getElementById('team2Color').value;

  try {
    const { data: userData } = await supabase.auth.getUser();
    if (!userData?.user?.id) throw new Error('Not signed in');

    const gameName = document.getElementById('gameName').value.trim();

    const { data, error } = await supabase
      .from('games')
      .insert({
        home_team: team1Name,
        away_team: team2Name,
        game_name: gameName || null,
        metadata: {
          team1Color,
          team2Color
        },
        created_by: userData.user.id,
        status: 'In Progress'
      })
      .select()
      .single();

    if (error) throw error;
    closeModal('game-setup-modal');
    await selectGame(data.id);
  } catch (err) {
    errorDiv.textContent = err.message || 'Failed to create game';
    console.error('Create game error:', err);
    createBtn.disabled = false;
  }
}

function openCreateGameModal() {
  resetCreateModal();
  openSetupModal('create');
}

function resetCreateModal() {
  const form = document.getElementById('gameForm');
  const errorDiv = document.getElementById('modal-error');
  if (form) form.reset();
  if (errorDiv) errorDiv.textContent = '';
}

// Event listeners for new events

document.addEventListener("DOMContentLoaded", async () => {
  await loadHTML("links", "/assets/app-links.html");
  await inlineSVGs();

  const params = new URLSearchParams(window.location.search);
  const gameId = params.get("game");
  const user = await checkAuth();
  if (user) {
    if (gameId) {
      await initGame(gameId);
    } else {
      await showGamePicker();
    }
  }

  // Sign-in button
  document.getElementById('signin-btn').addEventListener('click', async () => {
    const email = document.getElementById('email').value;
    const password = document.getElementById('password').value;
    if (email && password) {
      await signIn(email, password);
    } else {
      document.getElementById('signin-error').textContent = 'Please enter email and password.';
    }
  });

  const openCreateBtn = document.getElementById('open-create-game');
  if (openCreateBtn) {
    openCreateBtn.addEventListener('click', () => {
      openCreateGameModal();
    });
  }

  const closePickerBtn = document.getElementById('close-game-picker');
  if (closePickerBtn) {
    closePickerBtn.addEventListener('click', () => closeModal('game-setup-modal'));
  }

  const openGameManagerLink = document.querySelector('[data-action="open-game-manager"]');
  if (openGameManagerLink) {
    openGameManagerLink.addEventListener('click', async () => {
      await showGamePicker();
    });
  }

  const cancelCreateBtn = document.getElementById('cancel-create');
  if (cancelCreateBtn) {
    cancelCreateBtn.addEventListener('click', () => {
      switchSetupView('picker');
      resetCreateModal();
    });
  }

  const gameForm = document.getElementById('gameForm');
  if (gameForm) {
    gameForm.addEventListener('submit', handleCreateGame);
  }

  // Header action buttons
  document.querySelectorAll('[data-action]').forEach(el => {
    el.addEventListener('click', async (event) => {
      const action = el.dataset.action;
      if (action === 'open-popup') {
        openPopup(el.dataset.target);
      } else if (action === 'open-account-menu') {
        const menu = document.getElementById('account-menu');
        if (menu) {
          menu.classList.toggle('hidden');
        }
      } else if (action === 'sign-out') {
        await signOut();
      }
    });
  });

  document.addEventListener('click', (event) => {
    const accountMenu = document.getElementById('account-menu');
    const accountButton = document.querySelector('[data-action="open-account-menu"]');
    if (!accountMenu || !accountButton) return;
    const target = event.target;
    if (accountButton.contains(target) || accountMenu.contains(target)) {
      return;
    }
    accountMenu.classList.add('hidden');
  });

  document.querySelectorAll('.new-event').forEach(el => {
    el.addEventListener('click', async (e) => {
      const eventType = e.currentTarget.classList[1];
      let metadata = {};

      if (eventType === 'shot') {
        // For now, assume 2 points; in future, add UI for 2/3
        metadata.points = 2;
      }

      // For player, assume prompt or default; in future, add input
      const player = prompt('Player number (optional):') || '';
      if (player) metadata.player = player;

      const eventData = {
        event_type: eventType,
        team_side: gameState.currentTeam,
        metadata: metadata
      };

      await recordEvent(eventData);
    });
  });

  // Clock controls
  const clockButton = document.getElementById('clock-button-symbol');
  if (clockButton) {
    clockButton.addEventListener('click', () => {
      if (gameState.clock.running) {
        stopClock();
        document.getElementById('clock-button-text').textContent = 'START';
      } else {
        startClock();
        document.getElementById('clock-button-text').textContent = 'STOP';
      }
    });
  }

  // Team toggle (add a button or click on team boxes)
  document.getElementById('team-1-box').addEventListener('click', () => {
    gameState.currentTeam = 'home';
    toggleTeam();
  });
  document.getElementById('team-2-box').addEventListener('click', () => {
    gameState.currentTeam = 'away';
    toggleTeam();
  });

  // Initialize clock display
  updateClockDisplay();
  updateShotClockDisplay();
  toggleTeam(); // Set initial active team
});

// Cleanup subscriptions on page unload
window.addEventListener('beforeunload', () => {
  if (realtimeChannel) {
    realtimeChannel.unsubscribe();
    console.log('Unsubscribed from real-time events');
  }
  if (statusChannel) {
    statusChannel.unsubscribe();
    console.log('Unsubscribed from game status');
  }
});