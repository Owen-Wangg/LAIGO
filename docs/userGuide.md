# User Guide

**Please ensure the application is deployed, instructions in the deployment guide here:**

- [Deployment Guide](./deploymentGuide.md)

Once you have deployed the solution, the following user guide will help you navigate the functions available.

| Index                               | Description                                                                                                  |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| [Administrator View](#admin-view)   | The administrator can register supervisors, change system prompts and waiver.                                |
| [Supervisor View](#supervisor-view) | The supervisor can view advocates cases and provide feedback.                                                |
| [Advocate View](#advocate-view)     | The advocate can start a case, interact with AI Assistant, create summaries and transcribe audio interviews. |

All users start by filling their information at the sign up page.
![image](./media/create-account.png)

You then get a confirmation email to verify your email and are registered as a user.

## Administrator View

### Manage Users Page

The first user that signs up will automatically be assigned an administrator role. Upon logging in as an administrator, they will see the following home page where they can view all the users in the application, their names, emails, and highest privilege role. Administrators can browse for specific users using the searchbar, or filter to view certain roles using the role dropdown menu.:
![image](./media/admin-home.png)

Clicking the pencil icon for a user opens the user management panel, where administrators can assign/remove different roles for a user:
![image](./media/admin-manage-user.png)

If the selected user is a supervisor, administrators can also assign advocates to the supervisor by entering the advocate's email, and remove existing advocates by clicking the red trash icon.
![image](./media/admin-manage-supervisor.png)

### Settings Page

Clicking on the settings icon in the header opens the main settings page. The left hand-side shows a sidebar to swap between several different settings and panels, the right-hand side shows the setting configuration options.

![image](./media/admin-settings-page.png)

#### General Configurations

The General Configurations tab allows administrators to modify the configuration of the default model used across the application, message limits for users, and file upload limits:
![image](media/admin-general-configs.png)

#### Terminology

The Terminology tab allows administrators to modify the user terminology displayed across the application and manage available case type.

The panel includes:

- Role Labels: update how user roles are named across the app.
  ![image](./media/admin-role-labels.png)
- Case Types: manage allowed case types during case creation.
  ![image](./media/admin-case-types.png)

#### Signup Access

The Signup Access tab allows administrators to control whether the application allows anyone to sign up, or only certain emails can sign up. Administrators can toggle public signup on and off, and upload a csv whitelist formatted as "email,role" to allow specific users to sign up.

- In both modes, the email domain must be in the allowed domain list set at deployment (`/LAIGO/AllowedEmailDomains`).
- Users that sign up while public signup is disabled are given the role from their whitelist entry.
- Users that sign up while public signup is enabled are given the advocate role.
- The role column takes the role labels currently configured in the Terminology tab (for example "Advocate" or "Supervisor"), case-insensitive. An optional header row `email,role` is skipped.
- Uploading a CSV replaces the existing whitelist.

![image](./media/admin-whitelist.png)

#### Prompt Management

Administrators can edit the system prompts that run various parts of the application. The sidebar groups them into reasoning prompts (one per interview stage), assessment prompts (one per stage), and summary prompts (one per stage plus "Full Case Synthesis").

The Version History panel allows admins to view existing versions of a particular system prompt, change the current active prompt for the application, delete versions, and also load versions into the Prompt Workspace to make modifications.

![image](media/admin-version-history.png)

The Workspace panel allows administrators to:

- Create new prompt versions by clicking the "Start New Draft" button in the top right
- Overwrite previous versions with new modifications by loading a previous prompt and clicking "Save".
- Use a previous version as a template by loading a previous prompt, making modifications, and clicking "Save as New Version"

![image](media/admin-prompt-editor.png)

#### Prompt Playground

The Prompt Playground allows administrators to test out different system prompts and LLM configurations in a chat interface that mimics the main application. Administrators can:

- Change model configuration through the Model Configuration Panel
- Select which system prompt to test using the dropdown menus in the System Prompt Panel
- Change the Mock Case context to simulate with the AI

![image](./media/admin-prompt-playground-config.png)

At the bottom, a chat interface allows administrators to chat with the AI, which will use all the configurations that were set above.

![image](./media/admin-prompt-playground-chat.png)

Clicking "Compare" in the top right duplicates all configuration options, allowing administrators to compare 2 separate configurations side by side.

![image](./media/admin-prompt-playground-compare-config.png)

### Disclaimer Page

The Disclaimer page allows administrators to edit the waiver and disclaimer text that advocates must agree to before using the application. It features all the same version control options administrators have with the system prompts.

![image](./media/admin-disclaimer-editor.png)
![image](./media/admin-disclaimer-version-history.png)

## Supervisor View

### Cases Page

Upon logging in as a supervisor, they will be greeted with a homepage that displays their own cases, and the cases of the advocates assigned to them. Supervisors can search for a case using the searchbar, and filter the visible cases based on status using the dropdown menu:

![image](./media/supervisor-home-page.png)

Supervisors have the ability to archive and delete their own cases, or their advocates cases by clicking on the ellipsis on a case:

![image](./media/supervisor-delete-archive-case.png)

Upon clicking on any of the cases, the supervisor can see all interactions of the advocate with the AI Assistant as well as all the summaries, notes and transcriptions. The supervisor can then give feed back from the "Case Feedback" tab:
![image](./media/supervisor-feedback.png)

### Prompts

Clicking the prompts icon in the header allows supervisors to view all the active prompts across the application.

![image](./media/supervisor-prompts.png)

## Advocate View

### Cases Page

Upon logging in as an advocate, they see this home page with their most recent cases and the statuses of these cases (i.e. In Progress, Submitted for review or Reviewed by Supervisor)

![image](./media/advocate-all-cases.png)

Advocates can click on a case and see the overview, summaries, transcriptions, notes as well as interact with the AI Assistant.

### New Case Page

To start a new case, advocates can click on the "New Case" button at the top of the screen. This page opens up a form with information the advocates can fill out about the jurisdiction, broad area of law and give a description of the case which will then be sent to the AI Assistant.

![image](./media/advocate-new-case.png)

### Case Page

Upon creating a new case, users will be redirected to the Case Overview panel. Here, they can see the details of their case, edit the case title & description, and also submit the case for a review to an available supervisor by selecting their name and clicking "Submit for Review":

![image](./media/advocate-case-overview.jpg)

The Interview Assistant panel is where users can interact with the AI. The main panel is where users can ask questions and receive responses. A progress bar is shown above to indicate the thoroughness of the user's analysis, and a feedback panel on the right-hand side continuously updates with suggestions for improvement.

A Guide icon is available in the header (top-right). Clicking it opens a help dialog that explains what the progress bar represents, how the feedback panel works, and what the system expects as you explore different parts of the case.

The Interview Assistant is divided into 4 stages, each focusing on a different aspect of case analysis:

1. **Intake & Facts** — Gather and organize the key facts of the case. The AI helps you identify relevant details, clarify the timeline, and ensure nothing important is missed.
2. **Legal Analysis** — Identify legal issues, research applicable law, and build your arguments. This stage combines issue spotting, research strategy, and argument construction into a single workflow.
3. **Contrarian Analysis** — Explore counterarguments and weaknesses in your position. The AI challenges your reasoning to help you prepare for opposing perspectives.
4. **Policy Context** — Consider the broader policy implications and societal context surrounding the case, helping you understand how your arguments fit within larger legal and social frameworks.

Each stage has its own progress bar. As you interact with the AI and demonstrate thorough analysis, the progress bar fills up. All stages can be opened at any time from the side menu. When a stage is complete, its progress bar is replaced by a completion message and the stage shows a check mark in the side menu.

![image](./media/advocate-interview-assistant.png)

Upon interacting with the AI Assistant, the advocate can choose to generate a downloadable summary pdf of the information and insights from the LLM by clicking on the "GENERATE SUMMARY" button below the AI message. This button then generates a downloadable pdf version of a summary which is viewable from the "Case Summaries" page:

- Users may also generate a full case summary by generating individual summaries across the 4 stages first, then clicking "Generate Full Case Summary".

![image](./media/advocate-case-summaries.png)

The advocate can also navigate to the "Case Transcriptions" tab to upload audio and transcribe. Click on the "Upload Audio" button to upload an audio file, and when done, Transcriptions will be viewable and downloadable in the main page.

![image](./media/advocate-transcriptions.png)

The user can also click on the Notepad button in the bottom left corner, which opens up a resizable and movable yellow legal pad where the user can note significant details of the particular case:

![image](./media/advocate-notes.jpg)
