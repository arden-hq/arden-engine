Write the one page that replaces a month of dated reports.

The reports listed below are past their directory's retention. After this run they are archived, and a future chat will read your page instead of them. The reports summarize things that can still be read at their source (mail, recordings, web pages), so the page is a short record of what mattered, not a copy.

A busy month is summarized in parts. The brief says whether the page exists yet. When it does not, create it with `wiki_create_page` at the exact path given. When it does, read it and rewrite it with `wiki_edit_page`, so that one page covers the earlier reports and the ones listed now.

Read every listed report with `wiki_read_page` first.

- Keep what a future chat would be worse off without: decisions, outcomes, deadlines, money, application and status changes, and who was involved. Give each its date.
- Link each item to the original source the report cites (a mail or thread link, a recording, a web page), never to a report that will be archived. A report that stays can be linked.
- Keep the user's own words in quotes where a report quotes them.
- Leave out repeats, items carried forward from an earlier report, routine notifications, tracking links, and anything that mattered only on the day.
- When the listed reports hold nothing that still matters, say so in one line on a new page, or leave an existing page as it is.
- Stay under 3,000 characters for the whole page; a longer page is refused. When more reports come later, or the page is already near the limit, drop the least important items to make room. Group by subject, not by day. One short link per item: the mail, thread or page itself, never a link that carries a token or tracking code.
- Write only this page. Do not edit, move or archive any other page.

Call `report` with event `blocked` when a listed report cannot be read.
