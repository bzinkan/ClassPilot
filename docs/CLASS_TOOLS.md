# Student Class tools

Companion to the SchoolPilot Class tools API. Five capabilities are negotiated individually: `helpRequestsV1`, `questionParkingV1`, `timerControlsV1`, `lessonActivitiesV1`, and `exitTicketsV1`. Each depends on scoped authority. The server decides which tools are enabled for the school and current student binding.

Students open **Class tools** from the existing floating menu:

- **Help now:** choose Assignment question, Blocked website, or Technical problem, with an optional 500-character explanation. Editing keeps the original queue time. Acknowledgement says “You're on my list.” Withdraw removes the request.
- **Questions for later:** submit a private nonurgent question (500 characters) and read the teacher's answer. An uncertain retry retains its request ID.
- **Lesson activity:** reopen directions and resource links, check individual tasks, and explicitly report Working, Stuck, Ready for review, or Finished. Stuck does not request help; checklist completion does not change status.
- **Exit ticket:** answer the teacher's choice or short-text prompt. The first accepted submission is retained; text is limited to 500 characters.
- **Timer:** the countdown or paused time restores after page reload. Completion never advances a routine.

Links remain subject to school restrictions. Identity or classroom-owner changes clear private UI and drafts. Lower revisions cannot restore ended state. Submissions verify exact identity, context and control revision before and after network work. Submitted text is not saved in poll-overlay storage.

Run `npm run check`, `npm test`, `npm run build`, and `npm run test:extension:chrome`. The Chrome gate includes `scripts/test-extension-class-tools.mjs` alongside existing suspension, restart, disconnect/reconnect and ACK tests. The new fixture blocks external DNS before extension startup and uses a temporary profile.

Release separately after SchoolPilot's additive API/schema deployment. The prepared extension version is 2.9.3; the canonical upload is `dist/ClassPilot-v2.9.3.zip`. Package preparation does not upload or publish it. Check the live Store version immediately before selecting a successor, update the package guard, and follow the repository's canonical release procedure. Enable school phases and individual backend capabilities only after compatibility verification.
