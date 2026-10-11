// eventsData.js — db loads for the events page. Events come through the shared windowed loader
// (recentData.createEventsLoader — the log grows without bound, so only the newest slice loads up
// front; the page's Load-older button pages on) and are ordered client-side by the analysis clock
// (asof — the message's own date), newest first. Everything else (projects / profiles /
// instructions / settings) loads through persist.loadAll so the persistence layer's record-id
// maps are hydrated — manual edits made on this page then UPDATE the existing records instead of
// creating duplicates.


const eventClock = (ev) => Number(ev.asof) || Number(ev._date_created) || 0

export { eventClock }
