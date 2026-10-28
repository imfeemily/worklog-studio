# Worklog Studio Homebrew Tap

Homebrew tap สำหรับติดตั้ง [Worklog Studio](https://github.com/imfeemily/worklog-studio) บน macOS แอปช่วยตรวจสอบและบันทึกเวลาทำงานลง Jira Cloud รวมถึงจับคู่ประชุมจาก Mac Calendar กับ Jira task

## ติดตั้ง

```bash
brew install imfeemily/tap/worklog-studio
worklog-studio
```

เปิด [http://127.0.0.1:8765/#settings](http://127.0.0.1:8765/#settings) เพื่อตั้งค่า Jira site URL, อีเมล, API token, เขตเวลา และ Board ID ของคุณเอง แอปทำงานใน Terminal และเปิดหน้าเว็บเฉพาะบนเครื่องนี้ หยุดด้วย `Ctrl+C` อย่าเปิดสองชุดพร้อมกันบนพอร์ต `8765`

หากใช้ Mac Calendar ให้ติดตั้ง Xcode Command Line Tools (`xcode-select --install`) สำหรับสร้างตัวอ่านปฏิทินครั้งแรก และอนุญาต Calendar access เมื่อ macOS ถาม

## อัปเดตหรือถอนการติดตั้ง

```bash
brew update
brew upgrade imfeemily/tap/worklog-studio
```

```bash
brew uninstall imfeemily/tap/worklog-studio
```

การถอนติดตั้งไม่ลบ Jira config, ประวัติการส่ง หรือ cache ที่ `~/Library/Application Support/Worklog Studio/` ข้อมูลนี้เป็นของผู้ใช้แต่ละคนและมี API token อยู่ด้วย จึงไม่ควรอัปโหลดหรือแชร์

## สำหรับผู้ดูแล Tap

- เก็บ `Formula/worklog-studio.rb` ไว้ที่ **root ของ repository** ไม่ใช่ `homebrew-tap/Formula/`
- เมื่อออกเวอร์ชันใหม่ ให้สร้าง release asset ใน [source repository](https://github.com/imfeemily/worklog-studio/releases) และอัปเดต URL, version, SHA-256 ของ Formula ให้ตรงกับไฟล์ที่เผยแพร่
- ทดสอบด้วย `brew install imfeemily/tap/worklog-studio`, `worklog-studio --version` และ `brew test imfeemily/tap/worklog-studio`

ดูวิธีสร้างไฟล์ release และ Formula ใน [คู่มือโปรเจกต์หลัก](https://github.com/imfeemily/worklog-studio)
