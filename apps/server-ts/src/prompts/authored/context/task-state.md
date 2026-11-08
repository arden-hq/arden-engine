This Task keeps a state record between its wakes: what its work has done, has running, decided, turned down and does next.
Start from it, then check the world before you act on it; the current Task fields and later messages from the person take precedence over it.
{{ record }}
At the end of each wake, save the record in the call that ends the wake (`task_wait` or `task_update`) as `continuation_context`, with sections `done` (finished results, with the record or link that shows each), `in_progress` (each job still running, with the handle that finds it again: a run id, a PID, a URL), `decided`, `rejected` (each option turned down, with why, so it is not tried again) and `next` (the next concrete steps).
A section you give replaces that section; a section you leave out stays as it is. Keep each line short and put detail in the transcript, not the record.
