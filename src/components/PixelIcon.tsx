export type PixelIconName =
  | "app"
  | "pencil"
  | "brush"
  | "graphite"
  | "watercolor"
  | "marker"
  | "eraser"
  | "undo"
  | "redo"
  | "new"
  | "latest"
  | "full"
  | "save"
  | "export"
  | "share"
  | "help"
  | "sparkle"
  | "heart"
  | "paw";

type PixelIconProps = {
  name: PixelIconName;
  className?: string;
};

export function PixelIcon({ name, className = "" }: PixelIconProps) {
  const commonProps = {
    className: `pixel-icon ${className}`,
    viewBox: "0 0 24 24",
    "aria-hidden": true,
    shapeRendering: "crispEdges" as const,
  };

  switch (name) {
    case "app":
      return (
        <svg {...commonProps}>
          <path fill="#533B49" d="M7 2h10v2h3v3h2v9h-2v3h-3v2H7v-2H4v-3H2V7h2V4h3z" />
          <path fill="#FFF5D9" d="M7 4h8v2h3v3h2v5h-2v2h-5v3H8v-2H5v-3H4V8h2V5h1z" />
          <rect fill="#F190AE" x="6" y="7" width="4" height="4" />
          <rect fill="#FFD36D" x="12" y="5" width="4" height="4" />
          <rect fill="#82C8BD" x="15" y="11" width="4" height="4" />
          <rect fill="#A89ADA" x="8" y="13" width="4" height="4" />
          <rect fill="#FFFDF2" x="6" y="5" width="2" height="2" />
          <rect fill="#533B49" x="12" y="16" width="3" height="3" />
          <rect fill="#FFF5D9" x="13" y="17" width="2" height="2" />
        </svg>
      );
    case "pencil":
      return (
        <svg {...commonProps}>
          <path fill="#66505C" d="M18 1h3v1h1v1h1v3h-1v1h-2v2h-2v2h-2v2h-2v2h-2v2h-2v2H8v2H6v1H2v-4h1v-2h2v-2h2v-2h2v-2h2V8h2V6h2V4h2V2h1z" />
          <path fill="#F3A7BC" d="M18 2h3v1h1v3h-2l-3-3z" />
          <rect fill="#FFD3DE" x="18" y="2" width="2" height="1" />
          <path fill="#B9A6C9" d="M16 4h2l2 2-2 2-2-2-1-1z" />
          <rect fill="#E7DDF0" x="16" y="4" width="2" height="1" />
          <path fill="#E9AC45" d="M14 6h2l2 2-9 9-3-1z" />
          <path fill="#FFD96F" d="M14 6h1l2 2-8 8-2-1z" />
          <path fill="#FFF0A8" d="M14 7h1l1 1-7 7H8z" />
          <path fill="#F1CE9F" d="M5 16h4v2H7v2H4v-3h1z" />
          <rect fill="#FFF0C6" x="5" y="16" width="2" height="2" />
          <path fill="#51404B" d="M3 19h2v2H3z" />
          <rect fill="#FFF6C8" x="11" y="11" width="1" height="1" />
        </svg>
      );
    case "brush":
      return (
        <svg {...commonProps}>
          <path fill="#66505C" d="M17 1h4v1h1v4h-1v2h-2v2h-2v2h-2v2h-2v3h-1v3h-2v2H4v-1H2v-5h1v-3h2v-2h5v1h2v-1h1V9h2V7h1V5h1z" />
          <path fill="#B97755" d="M18 2h3v3h-1v2h-2v2h-2v2h-2V8h1V6h2V4h1z" />
          <path fill="#E7A566" d="M18 2h2v3h-1v1h-2V4h1z" />
          <rect fill="#FFD99B" x="18" y="3" width="1" height="2" />
          <path fill="#E9E3E6" d="M12 10h2v3h-1v3H9v-4h2z" />
          <path fill="#AEBAC8" d="M9 14h4v3H9z" />
          <rect fill="#F8F5F0" x="10" y="12" width="2" height="2" />
          <path fill="#77C8BE" d="M5 12h4v2h1v4H9v3H5v-1H3v-4h1v-3h1z" />
          <path fill="#A9E4D8" d="M5 12h3v2H6v3H4v-3h1z" />
          <path fill="#E982A6" d="M3 18h3v-1h3v3H8v1H4v-1H3z" />
          <rect fill="#FFC7D7" x="4" y="18" width="2" height="1" />
          <rect fill="#FFF1B1" x="7" y="13" width="1" height="1" />
        </svg>
      );
    case "graphite":
      return (
        <svg {...commonProps}>
          <path fill="#66505C" d="M17 1h4v1h1v4h-2v2h-2v2h-2v2h-2v2h-2v2h-2v2H8v2H6v2H2v-4h1v-2h2v-2h2v-2h2v-2h2V8h2V6h2V4h2z" />
          <path fill="#5D6170" d="M17 3h3v3h-2v2h-2v2h-2v2h-2v2h-2v2H8l-2-2 2-2h2v-2h2V8h2V6h2V4h1z" />
          <path fill="#9398A8" d="M17 3h2v2h-2v2h-2v2h-2v2h-2v2H9l-1-1 2-2h2V8h2V6h2V4h1z" />
          <path fill="#D8D9DF" d="M16 4h1v2h-2v2h-1V6z" />
          <path fill="#D6B88B" d="M5 15h4v3H7v2H4v-3z" />
          <rect fill="#F2D7AA" x="5" y="15" width="2" height="2" />
          <rect fill="#454955" x="3" y="19" width="3" height="2" />
          <rect fill="#B8BBCA" x="19" y="3" width="2" height="2" />
          <rect fill="#6F7382" x="11" y="15" width="1" height="1" />
        </svg>
      );
    case "watercolor":
      return (
        <svg {...commonProps}>
          <path fill="#66505C" d="M16 1h5v1h1v5h-1v2h-2v2h-2v2h-2v3h-2v3h-2v2H8v2H3v-1H2v-5h1v-3h2v-2h5v1h2v-2h1V8h1V6h1V3h1z" />
          <path fill="#BA7D5B" d="M18 2h3v4h-2v2h-2v2h-2v2h-2V9h1V6h2V4h2z" />
          <path fill="#F0B776" d="M18 2h2v3h-2v2h-1V4h1z" />
          <path fill="#D9D5DE" d="M12 10h3v4h-2v3H9v-4h2z" />
          <rect fill="#A9B6C7" x="9" y="14" width="4" height="3" />
          <path fill="#6CBEC7" d="M5 13h4v2h1v4H9v2H5v1H3v-5h1v-3h1z" />
          <path fill="#A9E2DE" d="M5 13h3v2H6v3H4v-3h1z" />
          <path fill="#8E80CC" d="M17 14h3v2h2v4h-1v2h-5v-2h-1v-3h1v-2h1z" />
          <path fill="#C4BAEF" d="M18 15h1v2h1v2h-3v-2h1z" />
          <rect fill="#EAFBFA" x="6" y="14" width="1" height="2" />
        </svg>
      );
    case "marker":
      return (
        <svg {...commonProps}>
          <path fill="#66505C" d="M8 2h9v1h2v2h1v11h-2v2h-2v3h-1v2H7v-1H5v-2H4V7h1V4h2V2z" />
          <path fill="#F29CB7" d="M8 4h8v1h2v10h-2v2H8v-2H6V7h1V5h1z" />
          <rect fill="#FFC7D6" x="8" y="5" width="3" height="10" />
          <rect fill="#FFF0A7" x="7" y="8" width="11" height="4" />
          <rect fill="#E2C663" x="7" y="11" width="11" height="2" />
          <path fill="#9A8DCD" d="M8 17h8v3h-2v2H9v-2H7v-2h1z" />
          <rect fill="#C9C0F0" x="9" y="18" width="5" height="2" />
          <rect fill="#FFF0F5" x="9" y="4" width="3" height="1" />
          <rect fill="#D27195" x="16" y="6" width="2" height="8" />
        </svg>
      );
    case "eraser":
      return (
        <svg {...commonProps}>
          <path fill="#66505C" d="M7 4h9v1h2v2h2v2h2v6h-1v2h-2v1h-2v2H7v-1H5v-2H3v-2H2v-5h1V9h2V6h2z" />
          <path fill="#E9E3FA" d="M8 5h7v1h2v2h2v1l-7 7H9v-1H7v-2H5v-2H4V9h2V7h2z" />
          <path fill="#C4BCEA" d="M4 11h1v2h2v2h2v1h3l-2 2H7v-1H5v-2H4z" />
          <path fill="#F0A2B9" d="M15 7h2v1h2v2h1v4h-1v2h-2v1h-6z" />
          <path fill="#FFC9D7" d="M16 8h1v1h2v2h-1v2h-3v-3z" />
          <path fill="#D6819E" d="M11 16h6v-1h3v1h-2v1h-1v1h-6z" />
          <rect fill="#FFFDFC" x="8" y="6" width="4" height="1" />
          <rect fill="#FFF5FD" x="6" y="8" width="2" height="1" />
          <rect fill="#9D8BC3" x="7" y="18" width="4" height="1" />
        </svg>
      );
    case "undo":
      return (
        <svg {...commonProps}>
          <path fill="#66505C" d="M5 4h5v3h6v1h3v2h2v7h-1v2h-2v1h-6v-5h4v-1h-2v-1H9v3H5v-2H3v-2H1V9h2V7h2z" />
          <path fill="#66A98E" d="M6 6h2v3h8v1h2v2h1v5h-4v-1h2v-3h-2v-1H7v2l-4-3 3-3z" />
          <path fill="#8FD1B4" d="M6 7h1v3h9v1H8v1H6v1l-2-2 2-2z" />
          <rect fill="#D9F5E6" x="8" y="9" width="7" height="1" />
          <rect fill="#B8E7D1" x="4" y="10" width="2" height="1" />
          <rect fill="#4E816E" x="15" y="17" width="3" height="1" />
          <rect fill="#FFF2A7" x="18" y="12" width="1" height="1" />
          <rect fill="#F3A9BF" x="4" y="7" width="1" height="1" />
        </svg>
      );
    case "redo":
      return (
        <svg {...commonProps}>
          <path fill="#66505C" d="M14 4h5v3h2v2h2v3h-2v2h-2v2h-4v-3h-5v1H8v2h4v4H6v-1H4v-2H3v-7h2V9h3V7h6z" />
          <path fill="#8885C7" d="M16 6h2v2l3 3-3 3v-2h-9v1H7v4h2v1H5v-5h1v-2h2V9h9V8h-1z" />
          <path fill="#B5AFE9" d="M17 7h1v2l2 2-2 2v-2H9v-1h8z" />
          <rect fill="#E7E3FF" x="9" y="9" width="7" height="1" />
          <rect fill="#CFC9F6" x="18" y="10" width="1" height="2" />
          <rect fill="#706DA9" x="6" y="17" width="3" height="1" />
          <rect fill="#FFF2A7" x="5" y="12" width="1" height="1" />
          <rect fill="#87CDB8" x="19" y="7" width="1" height="1" />
        </svg>
      );
    case "new":
      return (
        <svg {...commonProps}>
          <path fill="#66505C" d="M5 2h11v1h2v2h2v17H4V3h1z" />
          <path fill="#FFF9E9" d="M6 4h8v5h4v11H6z" />
          <path fill="#D8EDF1" d="M14 4h2v2h2v2h-4z" />
          <rect fill="#FFFFFF" x="7" y="5" width="5" height="1" />
          <rect fill="#E6DFF1" x="6" y="18" width="12" height="2" />
          <path fill="#E985A6" d="M11 10h3v3h3v3h-3v3h-3v-3H8v-3h3z" />
          <rect fill="#FFC6D6" x="12" y="11" width="1" height="6" />
          <rect fill="#FFC6D6" x="9" y="14" width="6" height="1" />
          <rect fill="#FFF3AF" x="17" y="10" width="1" height="1" />
          <rect fill="#83C9BB" x="7" y="8" width="3" height="1" />
        </svg>
      );
    case "latest":
      return (
        <svg {...commonProps}>
          <path fill="#66505C" d="M5 3h13v1h2v2h1v14h-2v2H5v-1H3V5h2z" />
          <rect fill="#9BB9D8" x="4" y="7" width="14" height="13" />
          <path fill="#FFF9EA" d="M6 5h12v2h1v12H6z" />
          <path fill="#73BDB8" d="M8 3h8v1h2v4h-3V6H9v2H6V5h2z" />
          <rect fill="#B8E5DF" x="9" y="4" width="6" height="1" />
          <path fill="#EDA85B" d="M10 9h3v2h2v2h2v2h-2v2h-2v2h-3z" />
          <path fill="#FFDA86" d="M11 10h1v2h2v1h1v1h-1v1h-2v2h-1z" />
          <rect fill="#F39BB4" x="5" y="17" width="3" height="3" />
          <rect fill="#FFD0DC" x="5" y="17" width="1" height="1" />
          <rect fill="#D6F2EC" x="7" y="9" width="2" height="1" />
        </svg>
      );
    case "full":
      return (
        <svg {...commonProps}>
          <path fill="#66505C" d="M7 3h6v1h3v2h2V4h4v8h-8V8h2v1h1v5h-2v3h-3v2H7v-1H5v-2H3V9h1V7h1V5h2z" />
          <path fill="#948DCE" d="M8 4h5v1h3v2h1v3h4V5h-2v4h-1V7h-3V6H8v2H6v6h2v2h5v-1h2v-2h2v2h-1v2h-3v1H8v-1H6v-2H5V9h1V6h2z" />
          <path fill="#BBB4ED" d="M8 5h5v1h2v1H8v1H7V6h1z" />
          <path fill="#F39BB7" d="M10 9h2v1h2v1h2v2h-2v1h-2v1h-2z" />
          <path fill="#FFD0DC" d="M11 10h1v1h2v1h-2v1h-1z" />
          <rect fill="#E5E1FF" x="7" y="9" width="1" height="4" />
          <rect fill="#FFF2A7" x="3" y="3" width="3" height="1" />
          <rect fill="#FFF2A7" x="4" y="2" width="1" height="3" />
          <rect fill="#83CDB8" x="18" y="11" width="2" height="1" />
        </svg>
      );
    case "save":
      return (
        <svg {...commonProps}>
          <path fill="#66505C" d="M4 2h14v1h2v2h1v17H3V3h1z" />
          <path fill="#69B5BE" d="M5 4h12v1h2v15H5z" />
          <rect fill="#AEE4DF" x="5" y="4" width="3" height="14" />
          <rect fill="#D8F1ED" x="6" y="5" width="1" height="11" />
          <path fill="#FFF9E9" d="M8 4h9v8H8z" />
          <rect fill="#E9DDED" x="9" y="5" width="7" height="1" />
          <rect fill="#66505C" x="14" y="5" width="2" height="6" />
          <rect fill="#9F879B" x="14" y="6" width="1" height="4" />
          <path fill="#E98DAA" d="M7 14h10v6H7z" />
          <rect fill="#FFC7D7" x="8" y="15" width="8" height="1" />
          <rect fill="#FFF7E8" x="9" y="17" width="6" height="3" />
          <rect fill="#D7B7C5" x="10" y="18" width="4" height="1" />
          <rect fill="#FFF2A7" x="18" y="5" width="1" height="2" />
        </svg>
      );
    case "export":
      return (
        <svg {...commonProps}>
          <path fill="#66505C" d="M5 2h11v1h2v2h2v8h2v7h-2v2H4v-2H2v-7h2V3h1z" />
          <path fill="#FFF9E9" d="M6 4h9v1h2v8H5V5h1z" />
          <path fill="#A8D9D2" d="M6 9h10v3H6z" />
          <path fill="#8EB9D8" d="M5 12h12v2H5z" />
          <path fill="#ECA1B8" d="M8 6h3v2h2v2H6V8h2z" />
          <rect fill="#FFF0A9" x="13" y="5" width="2" height="2" />
          <path fill="#B6AFE7" d="M9 11h4v4h3l-5 5-5-5h3z" />
          <path fill="#E3DFFF" d="M10 12h2v5h1l-2 2-2-2h1z" />
          <rect fill="#F8E9F0" x="4" y="15" width="2" height="4" />
          <rect fill="#D58EA7" x="17" y="15" width="3" height="4" />
        </svg>
      );
    case "share":
      return (
        <svg {...commonProps}>
          <path fill="#66505C" d="M15 2h5v1h2v5h-1v2h-5V8h-2v1h-2v2h-2v2h2v2h2v1h2v-2h5v2h1v5h-2v1h-5v-1h-2v-3h-2v-1H9v1H4v-1H2v-5h1v-2h5v1h1V9h2V7h2V6h2z" />
          <path fill="#8B86CE" d="M16 4h4v4h-4V7h-2v1h-2v2h-2v5h2v1h2v1h2v-1h4v4h-4v-2h-2v-1h-3v-1H8v1H4v-4h4v1h1v-4h1V9h2V7h2V6h2z" />
          <rect fill="#C6C1F1" x="17" y="5" width="2" height="2" />
          <rect fill="#F5A7BC" x="5" y="14" width="2" height="2" />
          <rect fill="#A9E2D4" x="17" y="17" width="2" height="2" />
          <rect fill="#FFF1A7" x="11" y="11" width="2" height="2" />
        </svg>
      );
    case "help":
      return (
        <svg {...commonProps}>
          <path fill="#66505C" d="M5 3h14v1h2v2h1v10h-2v2h-6l-4 4H7v-4H4v-2H2V6h1V4h2z" />
          <path fill="#F4B4C7" d="M5 5h13v1h2v9h-2v1h-6l-3 3v-3H5v-2H4V7h1z" />
          <rect fill="#FFD9E3" x="6" y="6" width="11" height="2" />
          <path fill="#FFF1A7" d="M10 7h4v1h2v4h-2v1h-1v2h-3v-3h2v-1h1V9h-3z" />
          <rect fill="#FFF9D4" x="11" y="8" width="2" height="1" />
          <rect fill="#8D83C8" x="10" y="16" width="3" height="3" />
          <rect fill="#C9C2F0" x="11" y="16" width="1" height="1" />
        </svg>
      );
    case "sparkle":
      return (
        <svg {...commonProps}>
          <rect fill="#6D5163" x="10" y="2" width="4" height="20" />
          <rect fill="#6D5163" x="2" y="10" width="20" height="4" />
          <rect fill="#F5C85C" x="11" y="4" width="2" height="16" />
          <rect fill="#F5C85C" x="4" y="11" width="16" height="2" />
          <rect fill="#FFF2A6" x="10" y="8" width="4" height="6" />
          <rect fill="#FFFFFF" x="11" y="9" width="2" height="2" />
        </svg>
      );
    case "heart":
      return (
        <svg {...commonProps}>
          <path fill="#633F50" d="M4 5h5v2h6V5h5v2h2v7h-2v2h-2v2h-2v2h-2v2h-4v-2H8v-2H6v-2H4v-2H2V7h2z" />
          <path fill="#EE87A5" d="M5 7h4v2h6V7h4v2h1v4h-2v2h-2v2h-2v2h-4v-2H8v-2H6v-2H4V9h1z" />
          <rect fill="#FFC6D4" x="6" y="8" width="3" height="3" />
        </svg>
      );
    case "paw":
      return (
        <svg {...commonProps}>
          <rect fill="#6B5268" x="4" y="4" width="4" height="5" />
          <rect fill="#6B5268" x="10" y="2" width="4" height="6" />
          <rect fill="#6B5268" x="16" y="4" width="4" height="5" />
          <path fill="#6B5268" d="M7 13h2v-2h6v2h2v2h2v5H5v-5h2z" />
          <rect fill="#BFAFE8" x="5" y="5" width="2" height="3" />
          <rect fill="#BFAFE8" x="11" y="3" width="2" height="4" />
          <rect fill="#BFAFE8" x="17" y="5" width="2" height="3" />
          <path fill="#BFAFE8" d="M8 14h2v-2h4v2h2v2h2v3H6v-3h2z" />
          <rect fill="#DDD4FA" x="9" y="14" width="4" height="2" />
        </svg>
      );
  }
}
