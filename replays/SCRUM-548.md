# SCRUM-548 - Decimal input handling fix on Mapping Skor

Type: Bug | Status: QA - Passed | Labels: none

## Description

## ** #1 ** success toast wording difference between figma and actual 

> →  should follow figma design

Figma:

- [attachment]

Actual:

- [attachment]



##  **#2**  decimal input is not accepted when typed, however it's still acceped when copy-pasted

> → should thrown an inline error

> [Decimal Input Handling (Comma)](https://japfacom-my.sharepoint.com/:v:/g/personal/nabiila_syalianti_japfa_com/IQA_QAfkM8PaRojfVaP0cSrQAUrKliVxMc585vaYftasyh8?nav=eyJyZWZlcnJhbEluZm8iOnsicmVmZXJyYWxBcHAiOiJPbmVEcml2ZUZvckJ1c2luZXNzIiwicmVmZXJyYWxBcHBQbGF0Zm9ybSI6IldlYiIsInJlZmVycmFsTW9kZSI6InZpZXciLCJyZWZlcnJhbFZpZXciOiJNeUZpbGVzTGlua0NvcHkifX0&e=D1Xjtn) 



##  **#3**  The input holds the fractional amount: decimal comma or decimal digits are shown when copy-pasted

> → Inline error should be shown in these cases as well (similar to case #2)
> [Fractional Paste on decimal](https://japfacom-my.sharepoint.com/:v:/g/personal/nabiila_syalianti_japfa_com/IQCmnutigqrARJW8-n4asAqIAW0xD7H8B-DvnFz1LEuA4HI?nav=eyJyZWZlcnJhbEluZm8iOnsicmVmZXJyYWxBcHAiOiJPbmVEcml2ZUZvckJ1c2luZXNzIiwicmVmZXJyYWxBcHBQbGF0Zm9ybSI6IldlYiIsInJlZmVycmFsTW9kZSI6InZpZXciLCJyZWZlcnJhbFZpZXciOiJNeUZpbGVzTGlua0NvcHkifX0&e=AJtnyG)



##  **#4**  field input is not preserved when network fails, currently it is navigated back to mapping list page with dummy data

**Current**

- user fills form → submitted on no network conncection → success toast appear → navigated back to Mapping Skor List page displaying mocked data

> [Current behavior](https://japfacom-my.sharepoint.com/:v:/g/personal/nabiila_syalianti_japfa_com/IQA2xHowz5VzQIC8m8V1pDn1ARrDRFAyQpyGev4B0CRAJpI?nav=eyJyZWZlcnJhbEluZm8iOnsicmVmZXJyYWxBcHAiOiJPbmVEcml2ZUZvckJ1c2luZXNzIiwicmVmZXJyYWxBcHBQbGF0Zm9ybSI6IldlYiIsInJlZmVycmFsTW9kZSI6InZpZXciLCJyZWZlcnJhbFZpZXciOiJNeUZpbGVzTGlua0NvcHkifX0&e=r7EgPw)

**To Be**

- user fills form → submitted on no network conncection → network fail error message toast appear → form is not submitted → pre-filled form inputs are preserved → user are able to submit directly when connection is back on

> [Behavior Reference: Order Management](https://japfacom-my.sharepoint.com/:v:/g/personal/nabiila_syalianti_japfa_com/IQCRFx68r7AMS4KOcqkFy6e3AWYf5Yqy9kabgjMprhPb1T4?nav=eyJyZWZlcnJhbEluZm8iOnsicmVmZXJyYWxBcHAiOiJPbmVEcml2ZUZvckJ1c2luZXNzIiwicmVmZXJyYWxBcHBQbGF0Zm9ybSI6IldlYiIsInJlZmVycmFsTW9kZSI6InZpZXciLCJyZWZlcnJhbFZpZXciOiJNeUZpbGVzTGlua0NvcHkifX0&e=QBpT1x)

## Attachments
- image-20261009-023607.png
- image-20261009-023636.png
- image-20261013-023917.png
## Attachment files (open these, they are part of the ticket)

- image-20261009-023607.png: `/Users/jayesh@shurutech.com/closio-agent/replays/SCRUM-548-files/image-20261009-023607.png`
- image-20261009-023636.png: `/Users/jayesh@shurutech.com/closio-agent/replays/SCRUM-548-files/image-20261009-023636.png`
- image-20261013-023917.png: `/Users/jayesh@shurutech.com/closio-agent/replays/SCRUM-548-files/image-20261013-023917.png`
