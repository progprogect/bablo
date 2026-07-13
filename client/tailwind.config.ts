import type { Config } from "tailwindcss";

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        surface: "#0F172A",
        accent: "#22D3EE",
      },
    },
  },
  plugins: [],
} satisfies Config;
