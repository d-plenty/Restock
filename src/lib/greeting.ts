/** "Good morning", "Good afternoon" or "Good evening": the Home title on the phone and the web (0.9.5). */
export const greeting = (d = new Date()) => (d.getHours() < 12 ? 'Good morning' : d.getHours() < 17 ? 'Good afternoon' : 'Good evening');

/** "Tuesday 10 November", under the greeting. */
export const todayText = (d = new Date()) => d.toLocaleDateString('en-AU', { weekday: 'long', day: 'numeric', month: 'long' });
