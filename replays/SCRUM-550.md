# SCRUM-550 - No proper error message when the channel name more than 100 characters.

Type: Bug | Status: QA - Passed | Labels: none

## Description

In the database, the channel name is varchar with max 100 characters.

However, the error message in the API response is “`INTERNAL_SERVER_ERROR`“. It should be Validation_error.

[attachment]

[attachment]

## Attachments
- image-20261012-063004.png
- image-20261012-063104.png
- image-20261014-020628.png
## Attachment files (open these, they are part of the ticket)

- image-20261012-063004.png: `/Users/jayesh@shurutech.com/closio-agent/replays/SCRUM-550-files/image-20261012-063004.png`
- image-20261012-063104.png: `/Users/jayesh@shurutech.com/closio-agent/replays/SCRUM-550-files/image-20261012-063104.png`
- image-20261014-020628.png: `/Users/jayesh@shurutech.com/closio-agent/replays/SCRUM-550-files/image-20261014-020628.png`
