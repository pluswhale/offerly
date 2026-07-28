# Offerly

## Product Vision

Build an AI Career Copilot SaaS that helps candidates get job offers faster.

The platform should become a personal AI assistant that guides candidates through the whole hiring journey:

- understanding career goals
- improving CV
- analyzing opportunities
- preparing applications
- tracking progress
- improving interview success rate


## Target Users

Primary users:

- software developers
- tech professionals
- international candidates
- active job seekers


## MVP Features

The first version contains:

1. Dashboard

Purpose:
Provide daily guidance and progress tracking.

2. CV Analyzer

Purpose:
Analyze CV quality and provide actionable improvements.

3. Job Match

Purpose:
Compare CV with job descriptions and provide match score.

4. AI Apply Assistant

Purpose:
Help candidates prepare applications:
- cover letters
- application answers
- vacancy-specific recommendations

5. Job Tracker

Purpose:
Manage application pipeline.

Statuses:

- Saved
- Applied
- Interview
- Offer
- Rejected

6. AI Coach

Purpose:
Provide personalized career guidance using user context.


## Technical Requirements

Frontend:

- Next.js 16
- React 19
- TypeScript


Backend:

- Nest.js
- TypeScript


Database:

- Supabase PostgreSQL


Architecture:

- scalable SaaS architecture
- clean code
- SOLID
- DRY
- KISS
- YAGNI
- modular monolith approach


Infrastructure:

Prefer free hosting:

- Vercel
- Supabase
- Railway / Render


Constraints:

Solo developer.

Initial budget:
maximum $100.


Requirements:

- mobile-first
- premium modern SaaS design
- subscription ready
- Stripe ready
- crypto payment future support
- feature gating
- LLM caching
- cost optimization
- future browser extension support


## Product Principles

The product does not help users only create documents.

The goal:

Increase probability of receiving a job offer.

Every feature should answer:

"Does this help the user get an offer faster?"


Avoid:

- unnecessary complexity
- premature microservices
- expensive infrastructure
- features that don't validate MVP