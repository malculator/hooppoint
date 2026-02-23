async function loadHTML(id, path) {
  try {
    const res = await fetch(path);
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

loadHTML('navbar', '/assets/navbar.html');
loadHTML('links', '/assets/links.html');
loadHTML('footer', '/assets/footer.html');