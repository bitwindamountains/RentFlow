# Rental Manager — Full-Scale Product Plan

## 1. Product Summary

**Working Name:** RentFlow  
**Product Type:** Rental and property management platform  
**Primary Platforms:** Android, iOS, and Web  
**Initial Market:** Small-to-medium landlords, boarding house owners, apartment operators, and property managers  
**Initial Region:** Philippines, with architecture that can support international expansion

### Product Promise

> Know who owes you, what is happening in every unit, and how your rental business is performing — from one app.

RentFlow should replace the common mix of notebooks, spreadsheets, paper receipts, chat threads, and manual utility calculations.

---

# 2. Primary Goals

The full product should allow landlords to manage:

- Properties
- Rooms / rental units
- Tenants and occupants
- Leases
- Monthly rent
- Utilities
- Security deposits
- Payments
- Receipts
- Expenses
- Maintenance
- Documents
- Notifications
- Staff permissions
- Reports
- Tenant self-service
- Subscriptions
- Audit history

The product should remain simple enough for an owner with 3 units while scaling to organizations with 100+ units.

---

# 3. Target Users

## Property Owner

Needs to:

- See who has paid
- See outstanding balances
- Track occupancy
- Manage rent and utilities
- Generate receipts
- Monitor expenses
- View monthly profit

## Property Manager

Needs to:

- Manage assigned properties
- Add tenants
- Generate charges
- Record payments
- Handle maintenance
- Run reports

## Staff / Collector

Needs limited access to:

- Tenant balances
- Payment recording
- Receipts
- Meter readings
- Maintenance updates

## Tenant

Needs to:

- View balance
- View bills
- View payment history
- Download receipts
- Upload payment proof
- Submit maintenance requests
- Receive announcements

---

# 4. Product Scope

## Core Modules

1. Authentication
2. Organization management
3. Property management
4. Unit management
5. Tenant management
6. Lease management
7. Billing
8. Payment tracking
9. Utility billing
10. Deposits
11. Expenses
12. Maintenance
13. Receipts
14. Documents
15. Notifications
16. Reports
17. Tenant portal
18. Staff and permissions
19. Audit logs
20. Subscription management
21. Analytics
22. Import/export

---

# 5. User Roles

## Owner / Super Admin

Full access to:

- Organization
- Properties
- Units
- Tenants
- Leases
- Billing
- Payments
- Expenses
- Maintenance
- Reports
- Staff
- Settings
- Subscription

## Property Manager

Access can be limited to assigned properties.

Typical permissions:

- View/edit tenants
- Create leases
- Create charges
- Record payments
- Manage utilities
- Manage maintenance
- View reports

## Collector / Staff

Typical permissions:

- View balances
- Record payment
- Issue receipt
- Record meter reading

## Maintenance Staff

Typical permissions:

- View assigned work orders
- Update status
- Add notes
- Upload photos

## Tenant

Typical permissions:

- View own lease
- View balance
- View payment history
- Submit payment proof
- Download receipts
- Create maintenance requests
- View notices

---

# 6. Organization Management

An organization represents one rental business.

Example:

```text
Cebu Prime Rentals

Properties: 3
Units: 42
Occupied: 39
Vacant: 3
```

Settings:

- Business name
- Logo
- Contact information
- Address
- Currency
- Timezone
- Receipt prefix
- Default billing day
- Default due day
- Grace period
- Reminder settings
- Payment methods
- Subscription plan

---

# 7. Property Management

Supported property types:

- Boarding house
- Apartment
- Dormitory
- Condo portfolio
- House rentals
- Commercial units
- Mixed-use property

Property fields:

```text
id
organization_id
name
property_type
address
city
province
country
manager_id
status
created_at
updated_at
```

Property dashboard:

```text
Sunrise Boarding House

Units: 18
Occupied: 16
Vacant: 2

Expected This Month: ₱144,000
Collected: ₱121,500
Outstanding: ₱22,500
```

---

# 8. Unit / Room Management

Each property contains units.

Fields:

- Unit number
- Floor
- Unit type
- Monthly rent
- Deposit requirement
- Capacity
- Status
- Description
- Amenities
- Meter numbers
- Photos

Statuses:

- Vacant
- Occupied
- Reserved
- Maintenance
- Unavailable

Example:

```text
Room 201
Studio
₱6,500/month
Occupied
Tenant: Maria Santos
```

---

# 9. Tenant Management

Tenant profile:

- Full name
- Phone
- Email
- Permanent address
- Emergency contact
- Date of birth
- Occupation
- Employer
- Identification type
- Identification number
- Move-in date
- Notes
- Profile photo

Statuses:

- Active
- Former
- Pending

Support multiple occupants under one lease.

---

# 10. Lease Management

Lease fields:

```text
Lease ID
Property
Unit
Primary Tenant
Start Date
End Date
Monthly Rent
Billing Day
Due Day
Grace Period
Security Deposit
Penalty Rule
Status
```

Statuses:

- Draft
- Active
- Expiring
- Expired
- Terminated
- Renewed

Features:

- Lease creation
- Renewal
- Termination
- Contract upload
- Rent adjustment
- Deposit tracking
- Lease expiration alerts

Recommended reminders:

- 60 days before expiration
- 30 days before expiration
- 7 days before expiration

---

# 11. Billing System

Charge types:

- Rent
- Electricity
- Water
- Internet
- Parking
- Association fee
- Penalty
- Damage
- Cleaning
- Miscellaneous

Example:

```text
September 2026

Rent             ₱5,000
Electricity      ₱1,240
Water              ₱350
Previous Balance   ₱500

Total Due        ₱7,090
```

The system should support:

- One-time charges
- Recurring charges
- Automatic monthly rent generation
- Manual adjustments
- Discounts
- Penalties
- Waivers

---

# 12. Automatic Rent Generation

Example rule:

```text
Create rent charge:
Every 1st day of the month

Amount:
₱5,000

Due:
5th day of the month
```

The billing engine should generate charges through background jobs.

Never rely on the landlord manually generating every monthly rent bill.

---

# 13. Payment Management

Payment fields:

- Tenant
- Lease
- Amount
- Payment method
- Reference number
- Payment date
- Notes
- Proof attachment
- Recorded by

Payment methods:

- Cash
- GCash
- Maya
- Bank transfer
- Cheque
- Card
- Other

Statuses:

- Pending
- Confirmed
- Reversed
- Refunded

---

# 14. Partial Payments

Example:

```text
Rent Due: ₱5,000
Payment: ₱3,000
Remaining: ₱2,000
```

Payments should be allocated against individual charges.

A `payment_allocations` table is required so one payment can cover multiple charges and one charge can receive multiple payments.

---

# 15. Advance Payments

Example:

```text
Tenant pays: ₱15,000

Applied to:
September Rent  ₱5,000
October Rent    ₱5,000
November Rent   ₱5,000
```

Allow overpayments to become tenant credits when appropriate.

---

# 16. Payment Proof

Tenant may upload:

- GCash screenshot
- Maya screenshot
- Bank transfer screenshot
- Deposit slip

Workflow:

```text
Tenant uploads proof
↓
Status: Pending
↓
Owner reviews
↓
Approve / Reject
↓
Official payment created
↓
Receipt generated
```

---

# 17. Digital Receipts

Receipt example:

```text
RENTFLOW RECEIPT

Receipt #: RF-2026-000812

Tenant:
Maria Santos

Property:
Sunrise Apartments

Unit:
201

Amount:
₱5,000

Purpose:
September Rent

Method:
GCash

Date:
September 5, 2026
```

Support:

- PDF
- Image
- Print
- Share

Receipt numbers should be unique and sequential per organization.

---

# 18. Utility Billing

Utilities:

- Electricity
- Water
- Gas
- Other metered services

Workflow:

```text
Previous Reading
↓
Current Reading
↓
Consumption
↓
Rate
↓
Calculated Charge
↓
Tenant Bill
```

Example:

```text
Previous: 1234
Current: 1358
Usage: 124 kWh
Rate: ₱12.50
Charge: ₱1,550
```

Optional meter photo should be supported.

---

# 19. Shared Utility Allocation

Support landlords without individual meters.

Allocation options:

- Equal split
- Per occupant
- Percentage
- Manual amount
- Submeter calculation

---

# 20. Security Deposit Management

Track:

- Required deposit
- Paid deposit
- Held amount
- Deductions
- Refund

Move-out example:

```text
Deposit:          ₱10,000
Damage:           -₱1,500
Unpaid Utility:     -₱800

Refund:            ₱7,700
```

All deductions should have a reason and audit trail.

---

# 21. Expense Management

Categories:

- Repairs
- Utilities
- Cleaning
- Staff wages
- Supplies
- Insurance
- Taxes
- Renovation
- Internet
- Miscellaneous

Fields:

```text
Property
Category
Vendor
Amount
Date
Description
Receipt
Recorded By
```

---

# 22. Vendor Management

Store:

- Vendor name
- Contact
- Service category
- Address
- Notes
- Service history

Examples:

- Plumber
- Electrician
- Cleaner
- Security
- Contractor
- Internet provider

---

# 23. Maintenance Module

Tenant request example:

```text
Issue:
Leaking faucet

Priority:
Medium

Description:
Water keeps dripping.

Photo:
[attached]
```

Statuses:

- Open
- Assigned
- In Progress
- Waiting
- Resolved
- Closed

Track:

- Assigned staff/vendor
- Estimated cost
- Actual cost
- Photos
- Notes
- Resolution date

---

# 24. Unit Maintenance History

Example:

```text
Room 201

Sep 2026
Faucet repaired

Jun 2026
Aircon cleaned

Feb 2026
Door lock replaced
```

This helps owners understand long-term unit costs.

---

# 25. Inspection Module

Inspection types:

- Move-in
- Move-out
- Routine
- Damage assessment

Checklist example:

```text
Walls: Good
Floor: Minor scratches
Bathroom: Good
Aircon: Working
```

Support:

- Photos
- Notes
- Tenant signature
- Staff signature

This can be Phase 2 or later.

---

# 26. Documents

Store:

- Lease contracts
- IDs
- Receipts
- Inspection reports
- Utility documents
- Maintenance invoices
- Property documents

Metadata:

- Document type
- Property
- Unit
- Tenant
- Upload date
- Expiration date

Private files should use authenticated access or expiring signed URLs.

---

# 27. Notifications

Channels:

- In-app
- Push notification
- Email
- SMS later

Notification types:

- Rent due soon
- Rent due today
- Rent overdue
- Payment received
- Payment proof approved/rejected
- Utility bill created
- Lease expiring
- Maintenance update
- Property announcement

---

# 28. Automated Reminders

Example:

```text
3 days before due:
Rent Reminder

Due date:
Rent Due Today

3 days overdue:
Overdue Reminder

7 days overdue:
Second Reminder
```

Landlords should be able to configure reminder rules.

---

# 29. Tenant Portal

Tenant dashboard:

```text
Hello Maria

Balance:
₱6,240

Due:
September 10

[ Upload Payment Proof ]

Recent Payment
Sep 5 — ₱5,000 — Paid

Maintenance
1 Open Request
```

Features:

- Current balance
- Upcoming charges
- Payment history
- Receipt download
- Payment proof
- Maintenance requests
- Lease information
- Documents
- Notices

---

# 30. Owner Dashboard

The main dashboard should answer five questions:

1. Who has not paid?
2. How much should I collect?
3. How much have I collected?
4. Which units are vacant?
5. What currently needs attention?

Example:

```text
Expected Rent     ₱245,000
Collected         ₱201,500
Outstanding        ₱43,500

Occupancy             91%
Expenses           ₱37,800
Net Income         ₱163,700
```

Attention section:

```text
5 overdue tenants
2 leases expiring
3 maintenance requests
1 vacant unit
```

---

# 31. Reports

## Rent Collection

- Expected
- Collected
- Outstanding
- Collection rate

## Income

Breakdown by:

- Rent
- Utilities
- Fees
- Other income

## Expenses

Breakdown by:

- Property
- Category
- Vendor
- Date

## Net Income

```text
Income:   ₱201,500
Expenses:  ₱37,800
Net:      ₱163,700
```

## Aging Report

```text
Tenant          1-30     31-60     61-90    90+
Maria Santos    ₱5,000
John Cruz                 ₱10,000
```

## Occupancy

- Occupied units
- Vacant units
- Occupancy percentage
- Vacancy days
- Turnover rate

---

# 32. Tenant Ledger

Example:

```text
Sep 1
Rent Charge       +₱5,000

Sep 3
Electricity       +₱1,240

Sep 5
Payment           -₱5,000

Balance            ₱1,240
```

A complete immutable transaction history is critical.

---

# 33. Staff and Permissions

Use Role-Based Access Control.

Example permissions:

```text
properties.view
properties.edit

tenants.view
tenants.create
tenants.edit

payments.view
payments.create
payments.reverse

expenses.view
expenses.create

reports.view
settings.manage
```

Owners should be able to restrict staff to specific properties.

---

# 34. Audit Logs

Track sensitive activity.

Example:

```text
Sep 12, 10:42 AM

User:
John Admin

Action:
Reversed Payment

Amount:
₱5,000

Tenant:
Maria Santos
```

Audit entries should not be editable by normal users.

---

# 35. Search

Global search should find:

- Tenant
- Unit
- Property
- Receipt
- Payment
- Maintenance request
- Document

Example:

```text
Search: Maria

Results:
Maria Santos
Room 201
RF-2026-000812
```

---

# 36. Import / Export

Import:

- Properties
- Units
- Tenants
- Opening balances

Preferred initial format:

- CSV

Export:

- CSV
- Excel
- PDF

Exportable reports:

- Tenant list
- Rent ledger
- Payments
- Expenses
- Utilities
- Occupancy

---

# 37. Move-In Workflow

```text
Create Tenant
↓
Select Unit
↓
Create Lease
↓
Set Rent
↓
Set Deposit
↓
Upload Contract
↓
Collect Initial Payment
↓
Complete Move-In Inspection
↓
Activate Lease
```

---

# 38. Move-Out Workflow

```text
Set Move-Out Date
↓
Final Utility Reading
↓
Move-Out Inspection
↓
Calculate Outstanding Balance
↓
Apply Deposit Deductions
↓
Calculate Refund
↓
Close Lease
↓
Mark Unit Vacant
```

---

# 39. Advanced Modules

After the core product is established:

- Applicant pipeline
- Rental inquiries
- Digital lease signing
- Property inventory
- Key management
- Parking management
- Visitor logs
- Vendor portal
- Owner portfolio analytics
- Accounting integrations
- Payment gateway integration
- API access

---

# 40. Recommended Technology Stack

## Mobile

- Ionic
- Angular
- TypeScript
- Capacitor

## Web Dashboard

- Angular
- TypeScript

## Backend

Recommended:

- Node.js
- NestJS

NestJS is preferred for a full-scale modular product.

## Database

- PostgreSQL

## ORM

- Prisma

## Cache / Jobs

- Redis
- BullMQ or equivalent job queue

## File Storage

- AWS S3
- Cloudflare R2
- Supabase Storage
- Equivalent private object storage

---

# 41. High-Level Architecture

```text
Android / iOS App
        │
Web Dashboard
        │
        ▼
    REST API
        │
        ├── Authentication
        ├── Organizations
        ├── Properties
        ├── Units
        ├── Tenants
        ├── Leases
        ├── Billing
        ├── Payments
        ├── Utilities
        ├── Expenses
        ├── Maintenance
        ├── Notifications
        └── Reports
              │
              ▼
          PostgreSQL
              │
       ┌──────┴──────┐
       ▼             ▼
     Redis       Object Storage
```

Start as a modular monolith.

Do not begin with microservices.

---

# 42. Backend Module Structure

```text
src/
├── auth/
├── organizations/
├── users/
├── roles/
├── properties/
├── units/
├── tenants/
├── occupants/
├── leases/
├── charges/
├── payments/
├── utilities/
├── deposits/
├── expenses/
├── vendors/
├── maintenance/
├── documents/
├── notifications/
├── reports/
├── subscriptions/
├── audit/
└── common/
```

---

# 43. Core Database Entities

```text
Organization
User
Role
Permission

Property
Unit

Tenant
Occupant

Lease

Charge
Payment
PaymentAllocation

UtilityMeter
MeterReading

DepositTransaction

Expense
Vendor

MaintenanceRequest

Document
Notification

AuditLog

Subscription
Plan
```

---

# 44. Key Database Tables

## organizations

```sql
id
name
logo_url
currency
timezone
status
created_at
updated_at
```

## properties

```sql
id
organization_id
name
property_type
address
city
province
country
manager_id
status
created_at
updated_at
```

## units

```sql
id
property_id
unit_number
floor
unit_type
monthly_rent
deposit_required
capacity
status
created_at
updated_at
```

## tenants

```sql
id
organization_id
first_name
last_name
email
phone
address
emergency_contact
occupation
status
created_at
updated_at
```

## leases

```sql
id
unit_id
tenant_id
start_date
end_date
monthly_rent
billing_day
due_day
deposit_amount
status
created_at
updated_at
```

## charges

```sql
id
lease_id
type
description
amount
billing_period
due_date
status
created_at
```

## payments

```sql
id
tenant_id
lease_id
amount
payment_method
reference_number
payment_date
status
receipt_number
recorded_by
created_at
```

## payment_allocations

```sql
id
payment_id
charge_id
amount
created_at
```

## expenses

```sql
id
property_id
category
vendor_id
amount
expense_date
description
receipt_url
created_by
created_at
```

---

# 45. Financial Integrity Rules

Because the application stores financial records:

- Use decimal database types for money
- Never use floating-point arithmetic for currency
- Use database transactions
- Avoid silently editing historical payments
- Prefer reversals over destructive edits
- Store `created_by`, `updated_by`, and timestamps
- Audit payment reversals
- Audit discounts
- Audit deposit deductions
- Keep receipt numbers unique

---

# 46. Multi-Tenant Security

Every business must be isolated by:

```text
organization_id
```

A user from Organization A must never access data from Organization B.

This must be enforced in backend authorization, not just frontend filtering.

---

# 47. Security Requirements

Minimum production requirements:

- HTTPS
- Strong password hashing
- Secure token/session handling
- Refresh token rotation
- Rate limiting
- Input validation
- Authorization guards
- SQL injection protection
- XSS protection
- CSRF protection where relevant
- Private document storage
- Signed file URLs
- Audit logs
- Encrypted secrets

Optional later:

- Two-factor authentication
- Passkeys
- Biometric mobile unlock

---

# 48. Privacy

The platform may contain:

- Names
- Phone numbers
- Addresses
- IDs
- Lease contracts
- Payment records
- Payment screenshots

Design for applicable privacy requirements, including Philippine Data Privacy Act obligations when operating locally.

Principles:

- Collect only required data
- Restrict staff access
- Allow account/data deletion where required
- Encrypt sensitive data
- Log sensitive access where appropriate
- Never expose IDs or contracts through public URLs

---

# 49. Backup and Recovery

Database:

- Automated daily backups
- Point-in-time recovery for production

Files:

- Durable object storage
- Versioning when affordable

Document:

- Recovery procedure
- Recovery Time Objective
- Recovery Point Objective

Provide users with manual exports.

---

# 50. Offline Mobile Support

Cache:

- Properties
- Units
- Tenant list
- Recent balances

Possible offline actions:

- Draft payment
- Meter reading
- Maintenance update

Clearly show:

```text
Not yet synced
```

Financial records should not appear finalized until server confirmation.

---

# 51. API Structure

Use REST initially.

Examples:

```text
POST /api/v1/auth/login

GET  /api/v1/properties
POST /api/v1/properties

GET  /api/v1/properties/:id/units

GET  /api/v1/tenants
POST /api/v1/tenants

POST /api/v1/leases

GET  /api/v1/charges
POST /api/v1/charges

POST /api/v1/payments

POST /api/v1/meter-readings

GET  /api/v1/reports/collection
```

Version APIs from the beginning.

---

# 52. Background Jobs

Use queued jobs for:

- Monthly rent generation
- Reminder notifications
- Lease expiration alerts
- Email delivery
- SMS delivery
- PDF generation
- Report generation
- File processing

Do not perform heavy work directly inside normal HTTP requests.

---

# 53. Performance Targets

Initial goals:

- Typical API: under 500 ms
- Dashboard: under 2 seconds
- Search: under 1 second
- Common reports: under 5 seconds
- Uploads processed asynchronously when large

These are engineering targets, not guarantees.

---

# 54. Testing Strategy

## Unit Tests

Prioritize:

- Rent calculations
- Utility calculations
- Penalties
- Discounts
- Payment allocation
- Deposit refund
- Shared utility calculations

## Integration Tests

Test:

- Authentication
- Authorization
- Database transactions
- Billing creation
- Payment posting
- Reversal workflows

## End-to-End Tests

Critical flow:

```text
Create Property
→ Create Unit
→ Add Tenant
→ Create Lease
→ Generate Rent
→ Record Payment
→ Generate Receipt
```

---

# 55. Core UX Navigation

## Mobile

```text
Home
Properties
Tenants
Payments
More
```

Quick Add:

```text
+ Record Payment
+ Add Tenant
+ Add Expense
+ Meter Reading
```

## Web

```text
Dashboard

Properties
Units
Tenants
Leases

Billing
Payments
Utilities
Deposits

Expenses
Maintenance

Documents
Reports

Staff
Settings
```

---

# 56. Onboarding

```text
Create Account
↓
Create Organization
↓
Add Property
↓
Add Units
↓
Add Tenant
↓
Create Lease
↓
Record First Payment
```

Target:

A new landlord should experience the core value within approximately 10 minutes.

---

# 57. Subscription Strategy

Suggested starting structure for the Philippine market.

## Free

```text
₱0
Up to 3 units
```

Includes:

- Tenant records
- Rent tracking
- Manual payments
- Basic receipts
- Basic reports

## Starter

```text
₱149/month
₱1,490/year
Up to 15 units
```

## Growth

```text
₱399/month
₱3,990/year
Up to 50 units
```

Adds:

- Utilities
- Expenses
- Maintenance
- Tenant portal
- Automated reminders

## Pro

```text
₱799/month
₱7,990/year
Up to 150 units
```

Adds:

- Staff accounts
- Advanced reports
- Audit logs
- Branded receipts
- Data export
- Multi-property reporting

Pricing must be validated with actual landlords before final launch.

---

# 58. Additional Revenue

Potential later revenue:

- SMS credits
- Payment-processing fees
- Additional staff seats
- Extra file storage
- Custom branding
- Data migration
- Enterprise onboarding
- Premium integrations

---

# 59. Key Product Metrics

Track:

- Registrations
- Activated organizations
- Properties created
- Units created
- Active leases
- Payments recorded
- Monthly rent tracked
- Monthly active landlords
- Free-to-paid conversion
- Subscription churn
- Tenant portal adoption
- Collection rate

### Activation Definition

A landlord has:

1. Created a property
2. Added a unit
3. Added a tenant
4. Created a lease
5. Recorded a payment

---

# 60. Recommended Market Entry

Start narrowly:

> Boarding houses, small apartment operators, and room-for-rent owners in the Philippines.

Why:

- Many still use manual tracking
- Shared utility billing is common
- GCash/Maya and cash workflows matter
- Enterprise property software is often excessive
- Mobile-first operation is valuable

---

# 61. Customer Discovery

Interview before expanding the product.

Suggested:

- 10 boarding house owners
- 10 apartment landlords
- 5 property managers

Questions:

- How do you track rent?
- How do tenants normally pay?
- How do you calculate utilities?
- What causes mistakes?
- What do you do when rent is late?
- Which reports matter?
- Would you pay monthly for software?
- What feature would make the product essential?

---

# 62. Competitive Positioning

Differentiate through:

## Simplicity

Built for small and growing landlords.

## Local Workflows

Support:

- Cash
- GCash
- Maya
- Shared utilities
- Boarding house rooms
- Digital receipts

## Mobile-First

Full operational workflows from a phone.

## Affordable Pricing

Lower complexity than enterprise tools.

## Strong Financial History

Reliable charge, payment, deposit, and receipt records.

---

# 63. Development Roadmap

## Phase 1 — Core Rental Engine

Build:

- Authentication
- Organization
- Property
- Units
- Tenants
- Leases
- Charges
- Payments
- Receipts
- Dashboard

### Release Target

Private alpha.

---

## Phase 2 — Daily Operations

Build:

- Utilities
- Deposits
- Expenses
- Maintenance
- Documents
- Basic reports

### Release Target

Closed beta.

---

## Phase 3 — Tenant Experience

Build:

- Tenant portal
- Payment proof
- Push notifications
- Announcements
- Maintenance submission

---

## Phase 4 — Business Management

Build:

- Staff accounts
- Permissions
- Audit logs
- Advanced reports
- Multi-property reporting
- Export

---

## Phase 5 — Automation

Build:

- Recurring rent
- Recurring charges
- Automated reminders
- Lease expiration alerts
- Background jobs

---

## Phase 6 — Commercialization

Build:

- Subscription plans
- Trials
- Usage limits
- Upgrade flows
- Subscription billing

---

## Phase 7 — Advanced Product

Build selectively based on demand:

- Inspections
- Applicant tracking
- Digital lease signing
- Inventory
- Parking
- Key management
- Vendor portal
- Payment gateway integrations
- Accounting integrations
- API access

---

# 64. Suggested Timeline

A full product should be released progressively.

## Months 1–2

Core landlord MVP.

## Months 3–4

Utilities, expenses, maintenance, reports.

## Months 5–6

Tenant portal and notifications.

## Months 7–8

Staff, permissions, audit, advanced reports.

## Months 9–12

Subscriptions, integrations, automation, scaling, and commercial polish.

A solo developer may take longer. The important strategy is to release and validate progressively.

---

# 65. Recommended MVP Boundary

The first public release should NOT include:

- AI
- Smart locks
- Visitor management
- Digital signatures
- Applicant screening
- Accounting replacement
- IoT meters
- Marketplace listings
- Microservices
- Enterprise SSO

These should wait until the core landlord workflow has real users.

---

# 66. AI Opportunities Later

Useful AI additions:

## Receipt OCR

Extract:

- Amount
- Date
- Vendor

## Lease Extraction

Extract:

- Start date
- End date
- Rent
- Deposit

## Maintenance Classification

Example:

```text
“There is water leaking under my sink.”

Suggested:
Category: Plumbing
Priority: Medium
```

## Natural-Language Reporting

Example:

```text
“How much did Sunrise Apartments earn last month?”
```

AI should enhance workflows, not become the core requirement.

---

# 67. First Production Vertical Slice

Build this workflow before anything else:

```text
Register
↓
Create Organization
↓
Create Property
↓
Create Unit
↓
Add Tenant
↓
Create Lease
↓
Generate Rent Charge
↓
Record Payment
↓
Generate Receipt
↓
Dashboard Updates
```

This proves the core system architecture.

---

# 68. Full-Scale Definition of Done

A mature RentFlow platform should reliably support:

- Multiple properties
- Hundreds of units
- Tenant history
- Lease lifecycle
- Automated rent
- Partial payments
- Advance payments
- Utility billing
- Deposits
- Expenses
- Maintenance
- Documents
- Tenant portal
- Notifications
- Staff permissions
- Reports
- Audit logs
- Subscription management
- Secure backups
- Data export
- Mobile and web access

---

# 69. Final Product Direction

Do not build an enterprise system merely because it has more features.

The strongest product is:

> **A simple rental operating system for small and growing landlords.**

Its foundation is:

```text
Property
+
Unit
+
Tenant
+
Lease
+
Charge
+
Payment
+
Utility
+
Expense
+
Maintenance
+
Reporting
```

Everything else should support those workflows rather than make them more complicated.

---

# 70. Implementation Readiness Review — September 14, 2026

The first production vertical slice in section 67 is implemented end to end. It is a deployable foundation, not the full-scale product described by every module in this plan.

## Verified Working Flow

```text
Owner registration and organization creation
→ Secure database-backed session
→ Property and unit
→ Tenant
→ Active lease
→ Posted rent charge
→ Partial or full payment allocation
→ Sequential receipt
→ Lease ledger and dashboard update
```

The API flow has both an isolated HTTP test and a PostgreSQL integration test. The PostgreSQL test closes and recreates the application, signs in again, and verifies that the accounting data and receipt survive the restart.

## Implemented Production Foundation

- Angular responsive web shell, authentication screen, live dashboard, guided setup, portfolio tables, lease table, billing table, payment history, and live payment workflow
- NestJS/Fastify versioned REST API with validated DTOs, CORS allow-listing, security headers, rate limiting, CSRF enforcement, and secure cookie sessions
- PostgreSQL/Prisma persistence with a committed initial migration
- Salted scrypt password hashes and SHA-256 session-token digests; raw session tokens exist only in HttpOnly cookies
- Organization-scoped queries and route-level owner, manager, and collector permissions
- Serializable charge and payment transactions, durable idempotency records, decimal money, payment allocations, receipts, ledger entries, and financial audit records
- Liveness/readiness endpoints, with readiness checking the database when persistence is enabled
- Clean production and development dependency audits at the time of this review

## Working with Limited Lifecycle Coverage

| Area | Current coverage | Still required |
|---|---|---|
| Authentication | Register, login, current profile, logout, expiry, CSRF | Email verification, password reset, MFA, active-session management, account lockout |
| Properties | Create and list properties/units | Edit/archive, photos, bulk import, property grants UI |
| Tenants | Create/list and calculated balance | Edit/archive, identity documents, complete history |
| Leases | Create/list and prevent double occupancy | Draft/approval, renew, terminate, move-out, proration |
| Billing | Manual posted rent/utility-style charges | Scheduled automatic generation, adjustments, waivers, reversals |
| Payments | Partial/full allocations, receipt, idempotency | Reversal/refund workflow, proof approval, printable/PDF receipt, unapplied-credit controls |
| Dashboard | Live totals and occupancy | Trends, date/property filters, expenses and net income |

## Planned Modules Not Yet Implemented

Utilities and meter allocation, deposits, expenses/vendors, maintenance/inspections, documents/file storage, notification jobs, tenant portal, reports/export, staff invitation and property grants, subscriptions, offline mobile, backups/restore automation, and production observability remain roadmap work. Their navigation destinations are design placeholders and must not be represented as completed features.

## Release Assessment

The section 67 vertical slice is ready for a controlled staging or pilot deployment after infrastructure configuration (managed PostgreSQL, TLS/reverse proxy, secrets, backups, logs/metrics, and email provider). The full-scale definition of done in section 68 is not yet complete.

---

# 71. Focused PWA Release — September 24, 2026

This release supersedes the remaining-work assessment in section 70 for the important landlord workflows. RentFlow is now an installable Angular PWA with a cached application shell; private organization data and financial mutations intentionally require a network connection and are not stored in the service-worker cache.

## Newly Completed

- Lease renewal and termination with unit release, occupant move-out, ended schedules, and audit history
- Automatic monthly rent schedules created with each new lease
- Safe manual or hourly scheduled billing runs with duplicate protection
- Payment reversal with voided receipt and compensating ledger entry
- Separate deposit receipts, deductions, adjustments, refunds, and balances
- Expense capture and net-cash reporting
- Maintenance work orders, priorities, assignment, and completion
- HTTPS document-link registry without building a custom file-storage system
- Computed reminders for overdue balances, expiring leases, and urgent maintenance
- Owner-managed staff invitations with expiring one-time tokens and role enforcement
- Financial summary and transaction CSV export
- Database backup command and concise production operations runbook
- PWA manifest, service worker, install prompt, standalone mode, and offline status UX

## Intentionally Deferred

To avoid over-engineering, this focused release does not include a separate tenant-facing application, native mobile apps, subscription billing, AI features, utility meter allocation, a custom email/SMS delivery platform, or custom object storage. Document files use secure HTTPS links, alerts are actionable in-app reminders, and production email, storage, monitoring, and backup retention should use managed providers.

## Release Position

The important owner and staff workflows are implemented and covered by PostgreSQL integration tests. Deployment still requires normal production infrastructure: managed PostgreSQL, TLS, secrets management, off-site backups, centralized logs, uptime alerts, and an email provider if invitation/reminder delivery is desired.
