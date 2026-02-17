// ===== MINIMAL FRONTEND LOGIC =====
const nameForm = document.getElementById('name-form');
const nameInput = document.getElementById('name-input');
const roomForm = document.getElementById('room-form');
const roomNameInput = document.getElementById('room-name');
const goPublicButton = document.getElementById('go-public');
const goPrivateButton = document.getElementById('go-private');

let username = '';
let roomname = '';
let hostname = window.location.host || 'room.soeparnocorp.workers.dev';

// ===== NAME FORM =====
nameForm.addEventListener('submit', e => {
  e.preventDefault();
  username = nameInput.value.trim();
  if (username) startRoomChooser();
});

function startRoomChooser() {
  nameForm.style.display = 'none';
  roomForm.style.display = 'flex';
}

// ===== ROOM FORM =====
goPublicButton.addEventListener('click', e => {
  roomname = roomNameInput.value.trim();
  if (roomname) joinRoom(roomname, false);
});

goPrivateButton.addEventListener('click', async e => {
  e.preventDefault();
  roomNameInput.disabled = true;
  goPublicButton.disabled = true;
  e.currentTarget.disabled = true;

  try {
    const resp = await fetch(`https://${hostname}/api/room`, { method: 'POST' });
    if (!resp.ok) throw new Error('Failed to create private room');
    roomname = await resp.text();
    joinRoom(roomname, true);
  } catch {
    alert('Something went wrong');
    location.reload();
  }
});

function joinRoom(room, isPrivate) {
  console.log('Joined room:', room, 'private:', isPrivate);
  // Untuk card minimal, cukup simpan room di localStorage
  localStorage.setItem('lastRoom', room);
  localStorage.setItem('yourName', username);
  alert(`Hello ${username}, your ${isPrivate?'private':'public'} room ID: ${room}`);
}
