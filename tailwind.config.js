import colors from 'tailwindcss/colors';

/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/renderer/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      // One accent (the blue of the app icon) and one family of greys
      colors: {
        accent: colors.blue,
        ink: colors.slate,
      },
      // A slightly larger scale than usual: easier to read for older eyes
      fontSize: {
        xs: ['13px', '18px'],
        sm: ['14px', '20px'],
        base: ['15px', '22px'],
        lg: ['17px', '24px'],
        xl: ['20px', '28px'],
        '2xl': ['24px', '32px'],
      },
      boxShadow: {
        soft: '0 1px 2px rgb(15 23 42 / 0.06), 0 1px 3px rgb(15 23 42 / 0.08)',
        dialog: '0 20px 50px -12px rgb(15 23 42 / 0.35)',
      },
    },
  },
  plugins: [],
};
