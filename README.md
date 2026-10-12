# Banned Bot — Discord Ban Manager

Bot Discord untuk mengelola hukuman (ban) player dengan jadwal mulai setiap hari **Senin jam 12 malam**.

## ✨ Fitur

- **Slash command `/banned`** dengan subcommand:
  - `/banned add` — Menambahkan ban baru (School / Makyo / Makyo & School)
  - `/banned remove` — Menghapus ban
  - `/banned list` — Merefresh pesan list ban
  - `/banned setup` — Set channel tempat list ban ditampilkan
  - `/banned whitelist add/remove/list` — Manage user yang diizinkan pakai bot
- **Authorization system** — Hanya user yang ada di **whitelist** yang bisa pakai command
- Input nama via **mention** (`@user`) atau **teks biasa**
- Durasi dalam **hari** (kosong = **permanent**)
- Untuk tipe **Makyo & School**, durasi School dan Makyo bisa diatur **berbeda**
- Hukuman **dimulai setiap hari Senin jam 00:00** (contoh: ban hari Rabu → mulai Senin depan)
- List ban otomatis **terupdate** saat ada player ditambah / dihapus / masa hukuman habis
- Jika durasi habis, player otomatis **dihapus dari list**
- Pengecekan expired tiap **1 menit**

## 📋 Persyaratan

- Node.js **v18+**
- NPM
- Discord Bot Token & Client ID

## 🚀 Instalasi di Pterodactyl

### 1. Upload file
Upload semua file ke direktori bot di Pterodactyl (misal `/home/container/banned-bot/`).

### 2. Install dependencies
```bash
cd /home/container/banned-bot
npm install
```

### 3. Set Environment Variables di Pterodactyl

Di tab **Startup** panel Pterodactyl, tambahkan variable:

| Variable       | Deskripsi                              |
| -------------- | --------------------------------------- |
| `DISCORD_TOKEN` | Token bot Discord                      |
| `CLIENT_ID`     | Application ID bot                     |
| `OWNER_ID`      | (Opsional) Discord user ID super-owner |
| `GUILD_ID`      | (Opsional) ID server untuk testing     |

**Startup Command:**
```
node index.js
```
atau
```
bash start.sh
```

### 4. Invite bot ke server
Pastikan bot punya permission: `Send Messages`, `Embed Links`, `Read Message History`, `Use Slash Commands`.

### 5. Setup channel
Jalankan `/banned setup` di channel yang ingin dijadikan tempat list ban.

### 6. Tambahkan user ke whitelist
Semua command (add/remove/list/setup) **hanya bisa dipakai oleh user yang terdaftar di whitelist**.

Cara pertama — via **Environment Variable**:
- Set `OWNER_ID` dengan Discord user ID kamu di panel Pterodactyl
- User tersebut otomatis masuk whitelist

Cara kedua — **auto-authorize** (jika `OWNER_ID` tidak diisi):
- User **pertama** yang menjalankan command bot akan otomatis masuk whitelist

Cara ketiga — via **slash command**:
```
/banned whitelist add user:@UserYangInginDiizinkan
/banned whitelist remove user:@UserYangDihapus
/banned whitelist list
```
> ⚠️ Hanya **owner** (atau user pertama) yang bisa manage whitelist.

## 🛡️ Authorization System

- **Whitelist** menyimpan daftar Discord user ID yang diizinkan memakai bot
- Jika `OWNER_ID` diisi di environment variable, user itu otomatis masuk whitelist dan tidak bisa dihapus
- Jika `OWNER_ID` tidak diisi, **user pertama** yang menjalankan command akan otomatis menjadi owner
- Hanya **owner** yang bisa menambah/menghapus user dari whitelist
- Command `/banned whitelist list` bisa dipakai siapa saja
- Data whitelist disimpan di `data/authorized.json`

## 🎮 Cara Penggunaan
```
/banned add type:From School name:PlayerA duration:7 reason:Toxic
/banned add type:From Makyo & School name:PlayerB duration_school:3 duration_makyo:14 reason:Cheating
/banned add type:From Makyo name:@PlayerC reason:Spam  ← permanent
```

### Melihat List
List ban otomatis tampil di channel yang sudah di-`/banned setup`.  
Atau jalankan `/banned list` untuk me-refresh.

### Menghapus Ban
```
/banned remove name:PlayerA
/banned remove name:@PlayerC
```

## 📁 Struktur File

```
banned-bot/
├── index.js          # Main bot
├── package.json
├── start.sh          # Startup script
├── .env.example
├── .gitignore
└── data/
    ├── bans.json     # Data ban (auto-generated)
    ├── channel.json  # Channel ID (auto-generated)
    └── message.json  # Message ID (auto-generated)
```

## ⚙️ Cara Kerja Durasi

- Input `2` → 2 hari
- Input kosong → **PERMANENT** (tidak akan kedaluwarsa)
- Durasi dihitung **setelah hari Senin** (hari mulai hukuman)

Contoh:
- Ban hari **Rabu**, durasi **7 hari** → hukuman mulai **Senin depan**, selesai **Senin berikutnya + 7 hari**
- Ban hari **Jumat**, tanpa durasi → **PERMANENT**, mulai **Senin depan**

## 🧹 Expired Ban

Setiap menit, bot mengecek ban yang sudah habis masa berlakunya:
- Ban **School** atau **Makyo** → langsung dihapus dari list
- Ban **Makyo & School** → jika salah satu habis, akan tetap tampil dengan indikasi ✅/❌
- Jika **keduanya** habis → dihapus dari list
