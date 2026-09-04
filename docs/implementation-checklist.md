# Cross-Spec Implementation Checklist

**Purpose:** Every major implementation issue MUST answer these questions before closure. If an issue cannot answer one, it is incomplete or requires a narrow architecture issue.

## Authority & Identity

1. What entity owns this state?
2. Which Principal is acting?
3. Which Capability is requested?
4. Which Resource is affected?
5. Which Grant permits it?
6. Which current security policy can deny it?
7. What budget applies (which level of the hierarchy)?
8. What is the effective authority (intersection of all ceilings)?

## Failure Semantics

9. What happens if the process dies before durable intent is recorded?
10. What happens if the process dies after durable intent but before external submission?
11. What happens on duplicate delivery?
12. What if external submission succeeded but acknowledgement was lost?
13. What is the retry class of each Operation?
14. What is the reconciliation strategy for submission_uncertain states?

## Evidence & Classification

15. What evidence proves the outcome?
16. What classification applies to the data involved?
17. Where can the data leave Forge (which destination classes)?
18. What secrets exist and which trusted process receives them?
19. Can a model or package influence authority-bearing fields?

## Cancellation & Versioning

20. What happens on cancellation during each phase?
21. What happens on revocation (current security policy)?
22. Which versions/policies/packages does historical evidence reference?
23. Is the Operation idempotent? With or without idempotency key?

## Testing

24. Which conformance test classes (C1-C8) apply?
25. What deterministic test proves each important claim?
26. What failure injection points are tested?
27. What property/invariant tests cover this change?
28. Is zero-token-idle proven where claimed?

## Checklist Template

```markdown
### Implementation Checklist

- [ ] Entity/state ownership identified
- [ ] Principal, Capability, Resource, Grant specified
- [ ] Current security policy denial path identified
- [ ] Budget level and limits specified
- [ ] Process-death semantics documented for each transition
- [ ] Duplicate delivery semantics documented
- [ ] Submission uncertainty handling specified
- [ ] Retry class specified per Operation
- [ ] Reconciliation strategy specified
- [ ] Evidence artifact structure specified
- [ ] Data classification specified
- [ ] Egress destinations authorized
- [ ] Secret/credential handling specified
- [ ] Authority-bearing fields identified and protected
- [ ] Cancellation semantics documented
- [ ] Revocation semantics documented
- [ ] Version/policy pinning documented
- [ ] Conformance test classes specified
- [ ] Deterministic tests written
- [ ] Failure injection tests written
- [ ] Property/invariant tests written
- [ ] Zero-token-idle proven (if claimed)
```
