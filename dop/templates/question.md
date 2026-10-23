# <one line, the way the complaint reached you>

<What the customer/operator/you observed. No diagnosis, no root cause, no file
names that give the answer away. If the real ask was vague, keep it vague —
working out what is being asked is part of the job.>

<Where the evidence is: ./files/...>

Write your answer to ./answer.json. Every field below must be present:

```json
{
  "culprit": "",
  "evidence": "",
  "why_it_was_missed": "",
  "fix": { "": "" },
  "does_not_fix": ""
}
```

The reasoning fields are graded on what they say, so write plain sentences, not
keywords. Answers that only name a component without saying why it is the cause
score low.
