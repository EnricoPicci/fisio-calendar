# Role
You are an experienced SW architect with more than 20 years of experience in building Cloud based applications on AWS and Front End and Back End apps using either Python or Node with Typescript or any other similar technology.
# Goal
You must build an app which helps fisiotherapists to manage their calendar.
# app description
## Features
The app must have the following features:
- must hold a calendar which is accessible both from the therapists and his clients
- the therapists can define when he is available
- there are 2 types of availability:
    - studio
    - swimming pool
- each availability can have different slots (e.g. studio allows only for 1 client at the time while pool allows for 3 clients at the time)
- the therapist can add, enable and block clients
- enabled clients can see the availability and block available slots or free up slots that they have formerly blocked
- at 0:00 AM the app sends a whatsapp message or an email or both to the clients who have blocked slots for that day, with reminder of the type of slot (studio or pool) and the time
- the therapists can cancel single slots or an entire day, in which case the app sends whatsapp messages and emails to all the clients that have blocked the cancelled slots
- sending whatsapp messages is an option that will be added later: for the moment the app sends only emails. The notification mechanism must be designed so that whatsapp can be added later without reworking the app
## Technology
- The app must be hosted on AWS and must have a responsive browser interface.
- Security is a first class concern.
- The app back end must be built using either Typescript on Node or Python, whichever is easier to build and maintain
- The Front End app must be written in Typescript with React or Angular or any other Front End framework that is easy to understand and maintain
- The DB can be Mongo on Atlas or any other technology is considered better
- The infrastructure must priviledge technologies that have a free plan (e.g. Mongo on Atlas or AWS Lambda functions) so that if the load is minimal the cost of infrastructure can be down to almost no cost
- It must be possible to test everything locally, without deploying any change to the cloud. Only when all tests pass locally the changes can be deployed to the cloud
- There must be a set of high level tests that are the executable documentation of the app. In particular
    - All back end APIs must have a set of tests that document their purpose
    - The Front End part of the app must have HTML pages which contains no logic and a set of Typescript classes that provide methods that HTML pages can invoke and reactive hooks that the HTML pages can subscribe to (hooks can be RxJS Observables or any other similar mechanism)
# Task
Your task is to create:
- an architectural document that describes the features of the app and the architecture of the app. The architectural document must be the base for creating an implementation plan as next step
- a document where you suggest which open source skills or other tools may be usefull to create such an app (e.g. tools that optimize the token consumption) - if no specific skills or tools are required and Claude Code can just do the work fine, state this
# Start when everything is clear
Ask any questions is needed to clarify the task. Start working only when everything is clear.s