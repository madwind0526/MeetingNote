import { useEffect, useState } from "react";

interface AvatarProps {
  name: string;
  photo?: string;
  size?: number;
  className?: string;
}

const AVATAR_COLORS = ["#1f6f68", "#2f7de1", "#c64f8a", "#c97c2c", "#6a5acd", "#3a6fd8", "#b0533f"];

function colorForName(name: string) {
  let hash = 0;
  for (let index = 0; index < name.length; index += 1) {
    hash = (hash * 31 + name.charCodeAt(index)) >>> 0;
  }

  return AVATAR_COLORS[hash % AVATAR_COLORS.length];
}

export function Avatar({ name, photo, size = 40, className }: AvatarProps) {
  const [imageFailed, setImageFailed] = useState(false);
  const initial = name.trim().charAt(0) || "?";
  const visiblePhoto = imageFailed ? "" : photo;

  useEffect(() => {
    setImageFailed(false);
  }, [photo]);

  return (
    <div
      className={`avatar${className ? ` ${className}` : ""}`}
      style={{
        width: size,
        height: size,
        fontSize: Math.round(size * 0.4),
        background: visiblePhoto ? undefined : colorForName(name || "?")
      }}
    >
      {visiblePhoto ? <img alt={name} onError={() => setImageFailed(true)} src={visiblePhoto} /> : initial}
    </div>
  );
}
