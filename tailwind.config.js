/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/renderer/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      fontSize: {
        'base': '18px',
        'lg': '20px',
        'xl': '24px',
        '2xl': '28px',
      },
    },
  },
  plugins: [],
};


