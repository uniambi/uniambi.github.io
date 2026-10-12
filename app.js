import { AudioEngine } from './audio.js';
import { PanoramaViewer } from './panorama.js';
import { VideoCache } from './video-cache.js';

const groups = [
  { id:'t2a', title:'Text to spatial audio', kicker:'TEXT CONDITIONED', description:'Sound scenes and speech, guided by a text prompt.', guide:'' },
  { id:'v2a', title:'Video to spatial audio', kicker:'VIDEO CONDITIONED', description:'Listen to the sound of a scene, generated from panoramic video.', guide:'Play any video to hear its method. ', strongGuide:'Drag the active view to look around.' },
  { id:'vt2a', title:'Video + text to spatial audio', kicker:'VIDEO & TEXT CONDITIONED', description:'Explore audio guided by both a panoramic scene and a text prompt.', guide:'FOA audio is rendered to binaural in real time. ', strongGuide:'Drag the active view to change the listening direction.' }
];
const $ = (query, root = document) => root.querySelector(query);
const engine = new AudioEngine();
const videoCache = new VideoCache(2);
const examples = $('#examples');
let data, previews = {}, groupIndex = -1, active = null, activeVideo = null, intent = 0, frameRequest = null;
const playIcon = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 2.5v11L13 8Z"/></svg>';
const pauseIcon = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 2h4v12H3zm6 0h4v12H9z"/></svg>';
const el = (tag, className, text) => { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; };
const time = n => { const s = Math.max(0, Math.floor(Number(n) || 0)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const modelPrompt = sample => String(sample.prompt || sample.caption || '');
const announce = message => { $('#announcer').textContent = message; };
const audioTypes = {foa:'FOA audio', mono:'mono audio', stereo:'stereo audio'};

function methodHeading(sample, version, tag, className) {
  const heading = el(tag, className, version.label);
  const baseline = sample.task === 'vt2a' && version.id !== 'ours' && version.id !== 'reference';
  const label = `${baseline ? 'Only ' : ''}${audioTypes[version.kind]}`;
  heading.append(document.createTextNode(' '), el('span', `audio-type${baseline ? ' baseline-note' : ''}`, `(${label})`));
  heading.title = version.kind === 'foa' ? 'Original WYZX FOA, rendered to binaural in real time; viewing direction updates the audio.' : version.formatLabel;
  return heading;
}

function updateProgress(track) {
  track.progress.max = track.duration;
  track.progress.value = track.offset;
  track.progress.setAttribute('aria-valuetext', `${time(track.offset)} of ${time(track.duration)}`);
  track.clock.textContent = `${time(track.offset)} / ${time(track.duration)}`;
}
function updateTrack(track) {
  const playing = active === track && engine.playing;
  track.node.classList.toggle('is-playing', playing);
  track.panel?.classList.toggle('is-playing', playing);
  track.button.innerHTML = playing ? pauseIcon : playIcon;
  track.button.setAttribute('aria-label', `${playing ? 'Pause' : 'Play'} ${track.version.label}: ${track.sample.title}`);
  track.button.setAttribute('aria-pressed', String(playing));
  updateProgress(track);
}
function stopTick() { if (frameRequest !== null) cancelAnimationFrame(frameRequest); frameRequest = null; }
function pauseActive() {
  intent++;
  stopTick();
  if (!active) return;
  if (engine.playing) active.offset = engine.pause();
  active.video?.pause();
  active.button.disabled = false;
  if (active.launch) active.launch.disabled = false;
  if (active.status) active.status.hidden = true;
  active.node.removeAttribute('aria-busy');
  updateTrack(active);
}

function releaseVideo() {
  const track = activeVideo;
  if (!track) return;
  track.video.pause();
  if (track.viewer) {
    // Keep a small still of this method's last view; release its video decoder and GL.
    const canvas = track.viewer.hasFrame ? track.viewer.canvas : track.viewer.hasPoster ? track.viewer.poster : null;
    if (canvas) { try { track.poster.src = canvas.toDataURL('image/jpeg', .75); } catch (_) { /* Static preview remains available. */ } }
    track.viewer.dispose(); track.viewer = null;
  }
  track.video.removeAttribute('src'); track.video.load(); track.video.hidden = true;
  track.poster.hidden = false; track.launch.hidden = false; track.status.hidden = true;
  activeVideo = null;
}

async function attachVideo(track, token) {
  if (!track.video || token !== intent) return;
  // Seeking temporarily lowers readyState; retain the existing decoder/viewer.
  if (activeVideo === track && track.viewer && track.video.getAttribute('src')) return;
  track.status.textContent = 'Loading video…'; track.status.hidden = false;
  const objectURL = await videoCache.get(track.sample.video);
  if (token !== intent) return;
  if (activeVideo !== track) releaseVideo();
  activeVideo = track;
  await new Promise((resolve, reject) => {
    const video = track.video;
    const cleanup = () => { clearTimeout(timer); video.removeEventListener('loadeddata', ready); video.removeEventListener('error', fail); video.removeEventListener('emptied', emptied); };
    const ready = () => { cleanup(); resolve(); };
    const fail = () => { cleanup(); reject(new Error('The video could not be decoded by this browser.')); };
    const emptied = () => { if (token !== intent) { cleanup(); reject(new DOMException('Playback cancelled.', 'AbortError')); } };
    const timer = setTimeout(() => { cleanup(); reject(new Error('Video loading timed out. Please try again.')); }, 15000);
    video.addEventListener('loadeddata', ready);
    video.addEventListener('error', fail);
    video.addEventListener('emptied', emptied);
    video.src = objectURL; video.load();
  });
  if (token !== intent) return;
  track.viewer = new PanoramaViewer(track.container, track.video, next => {
    Object.assign(track.orientation, next);
    track.output.textContent = `${Math.round(next.yaw)}° · ${Math.round(next.pitch)}°`;
    if (active === track) engine.setOrientation(next.yaw, next.pitch);
  });
  track.viewer.setOrientation(track.orientation.yaw, track.orientation.pitch);
  track.poster.hidden = true; track.launch.hidden = true; track.status.hidden = true;
}

async function seekVideo(track, position) {
  if (!track.video || track.video.readyState < 1) return;
  const video = track.video;
  const target = Math.min(position, Math.max(0, video.duration - .001));
  if (Math.abs(video.currentTime - target) < .02 && !video.seeking) return;
  await new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); video.removeEventListener('seeked', done); video.removeEventListener('emptied', cancel); };
    const done = () => { cleanup(); resolve(); };
    const cancel = () => { cleanup(); reject(new DOMException('Playback cancelled.', 'AbortError')); };
    const timer = setTimeout(() => { cleanup(); reject(new Error('Video seeking timed out.')); }, 10000);
    video.addEventListener('seeked', done, {once:true}); video.addEventListener('emptied', cancel, {once:true});
    video.currentTime = target;
  });
}

async function playTrack(track) {
  if (active === track && engine.playing) { pauseActive(); return; }
  pauseActive();
  if (activeVideo !== track) releaseVideo();
  active = track;
  const token = ++intent;
  track.requestToken = token;
  track.button.disabled = true;
  if (track.launch) track.launch.disabled = true;
  track.node.setAttribute('aria-busy', 'true');
  track.button.setAttribute('aria-label', `Loading ${track.version.label}`);
  track.error.hidden = true;
  try {
    // Resume from the user gesture before awaiting any network request.
    await engine.init();
    if (token !== intent) return;
    const [buffer] = await Promise.all([engine.load(track.version.url, track.version.kind), attachVideo(track, token)]);
    if (token !== intent) return;
    track.duration = buffer.duration;
    if (track.offset >= buffer.duration - .02) track.offset = 0;
    await seekVideo(track, track.offset);
    if (token !== intent) return;
    engine.setOrientation(track.orientation.yaw, track.orientation.pitch);
    await engine.play(buffer, track.version.kind, track.offset, () => {
      if (active !== track) return;
      track.offset = track.duration; track.video?.pause(); stopTick(); updateTrack(track);
    });
    if (token !== intent) return;
    if (track.video && track.offset < track.video.duration) await track.video.play();
    updateTrack(track); startTick();
    announce(`Playing ${track.version.label}: ${track.sample.title}`);
  } catch (error) {
    if (token !== intent) return;
    engine.pause(); track.video?.pause();
    track.error.textContent = `Playback unavailable: ${error.message}`; track.error.hidden = false;
    if (track.status) track.status.hidden = true;
    announce(track.error.textContent);
  } finally {
    if (track.requestToken === token) {
      track.button.disabled = false;
      if (track.launch) track.launch.disabled = false;
      track.node.removeAttribute('aria-busy'); updateTrack(track);
    }
  }
}

function makeTrack(sample, version, videoElements = {}) {
  const compact = Boolean(videoElements.video);
  const node = el('div', `track${version.id === 'ours' ? ' ours' : ''}${compact ? ' compact-track' : ''}`);
  node.dataset.method = version.id; node.dataset.kind = version.kind;
  node.title = version.formatLabel;
  const button = el('button', 'play-button'); button.type = 'button';
  node.append(button);
  if (!compact) {
    const label = el('div', 'track-label'); label.append(methodHeading(sample, version, 'div', 'method-label')); node.append(label);
  }
  const progress = el('input', 'track-progress'); progress.type = 'range'; progress.min = 0; progress.step = .01;
  progress.setAttribute('aria-label', `Seek ${version.label}: ${sample.title}`);
  const clock = el('span', 'track-time');
  const error = el('p', 'track-error'); error.hidden = true; error.setAttribute('role', 'alert');
  node.append(progress, clock, error);
  const track = {node, button, progress, clock, error, sample, version, orientation:{yaw:0,pitch:0}, offset:0, duration:version.duration || sample.duration, resumeOnSeek:false, viewer:null, ...videoElements};
  button.addEventListener('click', () => playTrack(track));
  progress.addEventListener('input', () => {
    const requestedOffset = Number(progress.value);
    if (active === track && engine.playing) { track.resumeOnSeek = true; pauseActive(); }
    track.offset = requestedOffset;
    if (activeVideo === track && track.video.readyState >= 2) track.video.currentTime = Math.min(track.offset, track.video.duration - .001);
    updateProgress(track);
  });
  progress.addEventListener('change', () => { if (track.resumeOnSeek) { track.resumeOnSeek = false; playTrack(track); } });
  updateTrack(track);
  return track;
}

function makeVideoPanel(sample, version) {
  const panel = el('section', `method-panel${version.id === 'ours' ? ' ours' : ''}`);
  panel.dataset.method = version.id;
  panel.setAttribute('aria-label', `${version.label}: ${sample.title}`);
  const heading = methodHeading(sample, version, 'h4', 'method-heading');
  const container = el('div', 'panorama-container');
  const video = el('video'); video.hidden = true; video.muted = true; video.defaultMuted = true; video.playsInline = true; video.preload = 'none';
  video.setAttribute('aria-label', `${version.label} video: ${sample.title}`);
  const poster = el('img', 'method-poster'); poster.src = previews[sample.video]; poster.alt = `${sample.title}, panoramic preview`; poster.loading = 'lazy'; poster.decoding = 'async'; poster.width = 640; poster.height = 360;
  const launch = el('button', 'video-launch'); launch.type = 'button'; launch.innerHTML = playIcon; launch.setAttribute('aria-label', `Play ${version.label} video: ${sample.title}`);
  const status = el('span', 'media-status'); status.hidden = true; status.setAttribute('role','status');
  container.append(video, poster, launch, status);
  const controls = el('div', 'view-controls');
  const reset = el('button', 'reset-view', '↺ Reset view'); reset.type = 'button'; reset.setAttribute('aria-label', `Reset ${version.label} viewing direction: ${sample.title}`);
  const output = el('output', '', '0° · 0°'); controls.append(reset, output);
  const track = makeTrack(sample, version, {panel, container, video, poster, launch, status, output});
  launch.addEventListener('click', () => playTrack(track));
  reset.addEventListener('click', () => {
    if (track.viewer) track.viewer.reset();
    else { track.orientation = {yaw:0,pitch:0}; track.output.textContent = '0° · 0°'; track.poster.src = previews[sample.video]; }
  });
  panel.append(heading, container, controls, track.node);
  return panel;
}

function makeCard(sample, index) {
  const card = el('article', `example-card${sample.video ? ' video-card' : ''}`); card.dataset.sample = sample.id;
  const heading = el('div', 'card-heading');
  heading.append(el('span', 'sample-number', String(index+1).padStart(2,'0')));
  if (sample.task !== 'v2a') {
    const prompt = el('h3', 'prompt-text', modelPrompt(sample)); prompt.id = `sample-${index}`;
    card.setAttribute('aria-labelledby', prompt.id);
    heading.append(prompt);
  } else {
    card.setAttribute('aria-label', `Video example ${index+1}`);
  }
  const content = el('div', 'card-content');
  const methods = el('div', `method-grid ${sample.video ? `video-grid columns-${sample.task === 'v2a' ? 3 : 4}` : 'audio-grid'}`);
  methods.setAttribute('aria-label', `Method comparison: ${sample.title}`);
  if (sample.video) {
    const versions = sample.versions.filter(version => version.id !== 'reference');
    for (const version of versions) methods.append(makeVideoPanel(sample, version));
    content.append(methods);
    const references = sample.versions.filter(version => version.id === 'reference');
    if (references.length) {
      const extra = el('div', 'supplemental-audio');
      for (const version of references) extra.append(makeTrack(sample, version).node);
      content.append(extra);
    }
  } else {
    for (const version of sample.versions) methods.append(makeTrack(sample, version).node);
    content.append(methods);
  }
  card.append(heading, content); return card;
}

function renderGroup(index, scroll = false) {
  if (!data) return;
  index = (index + groups.length) % groups.length;
  if (index === groupIndex) return;
  pauseActive(); engine.stop(); releaseVideo(); videoCache.clear(); active = null;
  groupIndex = index;
  const group = groups[index];
  const samples = data.groups.find(item => item.id === group.id).samples;
  document.querySelectorAll('.group-tab').forEach(tab => { tab.setAttribute('aria-selected', String(tab.dataset.group === group.id)); tab.tabIndex = tab.dataset.group === group.id ? 0 : -1; });
  $('#group-kicker').textContent = `${String(index+1).padStart(2,'0')} / 03 · ${group.kicker}`;
  $('#group-title').textContent = group.title; $('#group-description').textContent = group.description;
  $('#group-guide').replaceChildren(document.createTextNode(group.guide));
  if (group.strongGuide) $('#group-guide').append(el('strong', '', group.strongGuide));
  $('#group-guide').hidden = !group.guide && !group.strongGuide;
  $('#page-counter').textContent = `${String(index+1).padStart(2,'0')} / 03`;
  examples.setAttribute('aria-labelledby', `tab-${group.id}`);
  examples.replaceChildren(...samples.map(makeCard));
  history.replaceState(null, '', `#${group.id}`); document.title = `UniAmbi · ${group.title}`;
  announce(`${group.title}. ${samples.length} examples.`);
  if (scroll) $('.group-nav').scrollIntoView({behavior:'instant',block:'start'});
}
$('#previous-group').addEventListener('click', () => renderGroup(groupIndex-1));
$('#next-group').addEventListener('click', () => renderGroup(groupIndex+1));
$('#previous-bottom').addEventListener('click', () => renderGroup(groupIndex-1, true));
$('#next-bottom').addEventListener('click', () => renderGroup(groupIndex+1, true));
document.querySelectorAll('.group-tab').forEach(tab => {
  tab.addEventListener('click', () => renderGroup(groups.findIndex(group => group.id === tab.dataset.group)));
  tab.addEventListener('keydown', event => {
    let next;
    if (event.key === 'ArrowRight') next = (groupIndex+1)%3;
    if (event.key === 'ArrowLeft') next = (groupIndex+2)%3;
    if (event.key === 'Home') next = 0;
    if (event.key === 'End') next = 2;
    if (next === undefined) return;
    event.preventDefault(); renderGroup(next); $(`#tab-${groups[next].id}`).focus();
  });
});
$('#master-volume').addEventListener('input', event => engine.setVolume(Number(event.target.value)));
engine.setVolume(Number($('#master-volume').value));
window.addEventListener('hashchange', () => { const i = groups.findIndex(group => `#${group.id}` === location.hash); if (i >= 0) renderGroup(i); });
window.addEventListener('pagehide', () => { pauseActive(); releaseVideo(); videoCache.clear(); });
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') pauseActive();
  if (event.target.closest('input,button,video,canvas,a,summary,textarea,select')) return;
  if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') { event.preventDefault(); renderGroup(groupIndex + (event.key === 'ArrowRight' ? 1 : -1)); }
});
let lastProgress = 0;
function startTick() {
  if (frameRequest !== null) return;
  const tick = now => {
    frameRequest = null;
    if (!active || !engine.playing) return;
    if (now - lastProgress >= 80) {
      lastProgress = now; active.offset = engine.position; updateProgress(active);
      const video = active.video;
      if (video && !video.seeking && video.readyState >= 2 && active.offset < video.duration && Math.abs(video.currentTime-active.offset) > .18) video.currentTime = active.offset;
    }
    frameRequest = requestAnimationFrame(tick);
  };
  frameRequest = requestAnimationFrame(tick);
}
Promise.all(['data.json','previews.json'].map(url => fetch(url).then(response => { if (!response.ok) throw new Error(`HTTP ${response.status}`); return response.json(); }))).then(([model, posters]) => {
  data = model; previews = posters;
  const requested = groups.findIndex(group => `#${group.id}` === location.hash);
  renderGroup(requested >= 0 ? requested : 0);
}).catch(error => {
  const message = el('div','error-message',`The examples could not be loaded (${error.message}). Run python3 -m http.server 8000 in this folder, then open http://localhost:8000.`);
  message.setAttribute('role','alert'); examples.replaceChildren(message);
});
