```javascript
function selectPortal(role) {
    const message = document.getElementById("portal-message");

    if (role === "student") {
        message.textContent =
            "Student Portal selected. Student registration and secure login will be added next.";
    } else if (role === "admin") {
        message.textContent =
            "Management Portal selected. Secure administrator login will be added next.";
    }
}
```
