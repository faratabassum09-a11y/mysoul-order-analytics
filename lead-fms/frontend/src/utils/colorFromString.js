// Deterministically maps a string (department name, person name, etc.) to a
// hue, so the same value always renders the same color across the app
// without needing a maintained color list.
export function hueFromString(str = "") {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = str.charCodeAt(i) + ((hash << 5) - hash);
  }
  return Math.abs(hash) % 360;
}

export function chipStyleFromString(str = "") {
  const hue = hueFromString(str);
  return {
    background: `hsl(${hue} 82% 95%)`,
    color: `hsl(${hue} 55% 32%)`,
    borderColor: `hsl(${hue} 70% 85%)`,
  };
}

export function avatarStyleFromString(str = "") {
  const hue = hueFromString(str);
  return {
    background: `linear-gradient(135deg, hsl(${hue} 78% 60%), hsl(${(hue + 40) % 360} 78% 52%))`,
  };
}

export function initials(name = "") {
  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase())
    .join("");
}
