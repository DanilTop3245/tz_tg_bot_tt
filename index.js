require("dotenv").config();
const { Telegraf } = require("telegraf");
const https = require("https");
const XLSX = require("xlsx");

const bot = new Telegraf(process.env.BOT_TOKEN);

// === ФИЛЬТРЫ ПО УМОЛЧАНИЮ ===
let MAX_FOLLOWERS = 3000;
let MIN_VIDEOS_WITH_VIEWS = 2;
let MIN_VIEW_COUNT = 7000;

bot.start((ctx) => {
  ctx.reply(
    `<b>👋 TikTok Analyzer</b>\n\n` +
      `Отслеживай микро-инфлюенсеров с:\n` +
      `• Макс. фолловеров: ${MAX_FOLLOWERS}\n` +
      `• Видео с ≥ ${MIN_VIEW_COUNT} просмотрами: от ${MIN_VIDEOS_WITH_VIEWS}\n\n` +
      `<b>Команды:</b>\n` +
      `/analyze username - анализ аккаунта\n` +
      `/settings - текущие параметры\n` +
      `/set followers 3000 - максимум фолловеров\n` +
      `/set views 7000 - минимум просмотров\n` +
      `/set videos 2 - минимум популярных видео\n\n` +
      `<b>Пример:</b> /analyze username`,
    { parse_mode: "HTML" }
  );
});

bot.command("settings", (ctx) => {
  ctx.reply(
    `⚙️ <b>Текущие фильтры:</b>\n\n` +
      `• Подписчиков ≤ <b>${MAX_FOLLOWERS}</b>\n` +
      `• Минимум видео с ≥ <b>${MIN_VIEW_COUNT}</b> просмотров: <b>${MIN_VIDEOS_WITH_VIEWS}</b>\n\n` +
      `<b>Для изменения используйте:</b>\n` +
      `/set followers [число] - макс. фолловеров\n` +
      `/set views [число] - мин. просмотров\n` +
      `/set videos [число] - мин. популярных видео`,
    { parse_mode: "HTML" }
  );
});

bot.command("set", (ctx) => {
  const args = ctx.message.text.split(" ");
  if (args.length !== 3) {
    return ctx.reply(
      "❗ Неверный формат. Используйте:\n" +
        "/set followers 3000\n" +
        "/set views 7000\n" +
        "/set videos 2"
    );
  }

  const [_, field, value] = args;
  const num = parseInt(value);

  if (isNaN(num) || num < 0) {
    return ctx.reply("❗ Значение должно быть положительным числом");
  }

  switch (field) {
    case "followers":
      MAX_FOLLOWERS = num;
      ctx.reply(`✅ Максимум фолловеров установлен: ${num}`);
      break;
    case "views":
      MIN_VIEW_COUNT = num;
      ctx.reply(`✅ Минимум просмотров установлен: ${num}`);
      break;
    case "videos":
      MIN_VIDEOS_WITH_VIEWS = num;
      ctx.reply(`✅ Минимум популярных видео установлен: ${num}`);
      break;
    default:
      ctx.reply(
        "❗ Неизвестный параметр. Используйте: followers, views, videos"
      );
  }
});

bot.command("analyze", async (ctx) => {
  let username = ctx.message.text.split(" ")[1];
  if (!username) {
    return ctx.reply("❗ Укажите username без @\nПример: /analyze username");
  }

  username = username.replace(/[@\s]/g, "").toLowerCase();
  let statusMsgId = null;

  const updateStatus = async (text) => {
    try {
      if (statusMsgId) {
        await bot.telegram.editMessageText(
          ctx.chat.id,
          statusMsgId,
          null,
          text
        );
      } else {
        const msg = await ctx.reply(text);
        statusMsgId = msg.message_id;
      }
    } catch (error) {
      console.log(
        "Не удалось отредактировать сообщение, отправляю новое:",
        error.message
      );
      try {
        const msg = await ctx.reply(text);
        statusMsgId = msg.message_id;
      } catch (e) {
        console.log("Ошибка отправки сообщения:", e.message);
      }
    }
  };

  try {
    await updateStatus("🔍 Получаю информацию о пользователе...");

    const userInfo = await fetchUserInfo(username);
    if (!userInfo?.secUid) {
      const errorMsg = userInfo?.message?.includes("exceeded")
        ? "🚫 Превышен лимит запросов API. Обновите план на https://rapidapi.com/Lundehund/api/tiktok-api23"
        : "🚫 Не удалось получить данные пользователя. Проверьте username или статус аккаунта (приватный/удалённый).";
      return updateStatus(errorMsg);
    }

    await updateStatus("👥 Получаю список фолловеров...");
    const followers = await fetchAllFollowers(userInfo.secUid);

    console.log("✅ Получено фолловеров:", followers.length);
    if (!followers.length) {
      return updateStatus(
        "⚠️ Не удалось получить фолловеров (возможно, приватный аккаунт)."
      );
    }

    await updateStatus(`📊 Начинаю анализ ${followers.length} фолловеров...`);
    const results = [];
    let lastUpdateTime = Date.now();

    for (let i = 0; i < followers.length; i++) {
      const user = followers[i];
      const followersCount = user.stats?.followerCount || 0;

      if (followersCount > MAX_FOLLOWERS) {
        console.log(
          `⛔ Пропущен ${user.uniqueId} — ${followersCount} подписчиков`
        );
        continue;
      }

      const now = Date.now();
      if (i % 10 === 0 && now - lastUpdateTime > 3000) {
        await updateStatus(
          `📊 Анализирую ${i + 1}/${followers.length} фолловеров...`
        );
        lastUpdateTime = now;
      }

      const videos = await fetchUserVideos(user.secUid || user.uniqueId);
      console.log(
        `Пользователь ${user.uniqueId}: всего видео ${videos.length}`
      );

      if (videos.length === 0) {
        console.log(`⛔ Пропущен ${user.uniqueId} — нет видео`);
        continue;
      }

      const popularVideos = videos.filter((v) => v.playCount >= MIN_VIEW_COUNT);
      console.log(
        `Пользователь ${user.uniqueId}: популярных видео ${popularVideos.length}`
      );

      if (popularVideos.length < MIN_VIDEOS_WITH_VIEWS) {
        console.log(
          `⛔ Пропущен ${user.uniqueId} — недостаточно популярных видео`
        );
        continue;
      }

      results.push({
        Никнейм: user.nickname || user.uniqueId,
        Username: user.uniqueId,
        Email: extractEmail(user.signature),
        "Количество фолловеров": followersCount,
        Биография: user.signature || "—",
        "Ссылка на профиль": `https://www.tiktok.com/@${user.uniqueId}`,
        "Всего видео": videos.length,
        "Популярных видео": popularVideos.length,
        "Макс. просмотров": Math.max(...videos.map((v) => v.playCount)),
        "Ср. просмотров": Math.round(
          videos.reduce((sum, v) => sum + v.playCount, 0) / videos.length
        ),
      });

      console.log(`✅ Добавлен ${user.uniqueId} в результаты`);
    }

    if (!results.length) {
      return updateStatus("❗ Ни один пользователь не прошёл фильтр.");
    }

    await updateStatus("📄 Создаю отчёт...");
    const fileName = `analyze_results_${username}_${Date.now()}.xlsx`;
    const buffer = saveToExcel(results);

    await updateStatus(
      `✅ Найдено ${results.length} подходящих пользователей!`
    );
    await ctx.replyWithDocument({
      source: buffer,
      filename: fileName,
    });
  } catch (error) {
    console.error("Ошибка при анализе:", error);
    try {
      await updateStatus("❌ Произошла ошибка. Попробуйте позже.");
    } catch (e) {
      console.log("Не удалось отправить сообщение об ошибке:", e.message);
    }
  }
});

// === ФУНКЦИИ =====

function fetchUserInfo(username) {
  return new Promise((resolve) => {
    const options = {
      method: "GET",
      hostname: "tiktok-api23.p.rapidapi.com",
      path: `/api/user/info?uniqueId=${encodeURIComponent(username)}`,
      headers: {
        "x-rapidapi-key": process.env.RAPIDAPI_KEY,
        "x-rapidapi-host": "tiktok-api23.p.rapidapi.com",
      },
    };

    const req = https.request(options, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        try {
          const json = JSON.parse(Buffer.concat(chunks).toString());
          console.log(
            "API Response for user info:",
            JSON.stringify(json, null, 2)
          );
          resolve(json.userInfo?.user || null);
        } catch (e) {
          console.log("❌ Ошибка парсинга данных пользователя:", e.message);
          resolve({ message: e.message });
        }
      });
    });

    req.on("error", (err) => {
      console.log("❌ Ошибка запроса пользователя:", err.message);
      resolve({ message: err.message });
    });

    req.end();
  });
}

async function fetchAllFollowers(secUid) {
  let allFollowers = [];
  let minCursor = 0;
  const count = 50;

  while (true) {
    const followers = await fetchFollowersBySecUid(secUid, minCursor, count);
    allFollowers = allFollowers.concat(followers);

    if (followers.length < count) break;
    minCursor += count;

    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  return allFollowers;
}

function fetchFollowersBySecUid(secUid, minCursor, count) {
  return new Promise((resolve) => {
    const options = {
      method: "GET",
      hostname: "tiktok-api23.p.rapidapi.com",
      path: `/api/user/followers?secUid=${encodeURIComponent(
        secUid
      )}&count=${count}&minCursor=${minCursor}`,
      headers: {
        "x-rapidapi-key": process.env.RAPIDAPI_KEY,
        "x-rapidapi-host": "tiktok-api23.p.rapidapi.com",
      },
    };

    const req = https.request(options, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        try {
          const json = JSON.parse(Buffer.concat(chunks).toString());
          if (json.message?.includes("exceeded")) {
            console.log("❌ Превышен лимит запросов:", json.message);
            resolve([]);
            return;
          }
          const followers = (json.userList || []).map((item) => ({
            ...item.user,
            stats: item.stats || item.statsV2 || {},
          }));
          resolve(followers);
        } catch (e) {
          console.log("❌ Ошибка парсинга фолловеров:", e.message);
          resolve([]);
        }
      });
    });

    req.on("error", (err) => {
      console.log("❌ Ошибка запроса фолловеров:", err.message);
      resolve([]);
    });

    req.end();
  });
}

async function fetchUserVideos(id) {
  const maxRetries = 3;
  let retryCount = 0;
  const endpoint = `/api/user/posts?secUid=${encodeURIComponent(
    id
  )}&count=50&cursor=0`;

  while (retryCount < maxRetries) {
    try {
      const videos = await new Promise((resolve) => {
        const options = {
          method: "GET",
          hostname: "tiktok-api23.p.rapidapi.com",
          path: endpoint,
          headers: {
            "x-rapidapi-key": process.env.RAPIDAPI_KEY,
            "x-rapidapi-host": "tiktok-api23.p.rapidapi.com",
          },
        };

        const req = https.request(options, (res) => {
          const chunks = [];
          res.on("data", (chunk) => chunks.push(chunk));
          res.on("end", () => {
            const responseText = Buffer.concat(chunks).toString();
            console.log(`🔍 Получение видео для ${id}:`, endpoint);
            console.log(
              `📄 Ответ:`,
              responseText.substring(0, 200) +
                (responseText.length > 200 ? "..." : "")
            );

            try {
              const json = JSON.parse(responseText);
              if (json.message?.includes("exceeded")) {
                console.log("❌ Превышен лимит запросов:", json.message);
                resolve([]);
                return;
              }
              const videos = json.data?.videos || json.itemList || [];
              console.log(`✅ Найдено ${videos.length} видео для ${id}`);
              resolve(videos);
            } catch (e) {
              console.log("❌ Ошибка парсинга видео:", e.message);
              resolve([]);
            }
          });
        });

        req.on("error", (err) => {
          console.log("❌ Ошибка HTTP запроса:", err.message);
          resolve([]);
        });

        req.end();
      });

      if (videos.length > 0) return videos;
      retryCount++;
      console.log(`⚠️ Повторная попытка ${retryCount}/${maxRetries} для ${id}`);
      await new Promise((resolve) => setTimeout(resolve, 1000 * retryCount));
    } catch (error) {
      console.log(`❌ Ошибка в fetchUserVideos: ${error.message}`);
      retryCount++;
      await new Promise((resolve) => setTimeout(resolve, 1000 * retryCount));
    }
  }

  console.log(
    `❌ Не удалось получить видео для ${id} после ${maxRetries} попыток`
  );
  return [];
}

function extractEmail(bio = "") {
  const emailRegex = /[\w.-]+@[\w.-]+\.[a-zA-Z]{2,}/g;
  const matches = bio.match(emailRegex);
  return matches ? matches.join(", ") : "—";
}

function saveToExcel(data) {
  try {
    const ws = XLSX.utils.json_to_sheet(data);
    const colWidths = [
      { wch: 20 }, // Никнейм
      { wch: 20 }, // Username
      { wch: 25 }, // Email
      { wch: 15 }, // Количество фолловеров
      { wch: 50 }, // Биография
      { wch: 40 }, // Ссылка на профиль
      { wch: 12 }, // Всего видео
      { wch: 15 }, // Популярных видео
      { wch: 15 }, // Макс. просмотров
      { wch: 15 }, // Ср. просмотров
    ];
    ws["!cols"] = colWidths;

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Результаты анализа");
    const buffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
    console.log("✅ Файл Excel создан в памяти");
    return buffer;
  } catch (error) {
    console.error("❌ Ошибка создания файла Excel:", error);
    throw error;
  }
}

// === ОБРАБОТКА ОШИБОК ===
bot.catch((err, ctx) => {
  console.error("❌ Ошибка в боте:", err);
  try {
    if (ctx && ctx.reply) {
      ctx.reply("❌ Произошла ошибка. Попробуйте позже.");
    }
  } catch (replyError) {
    console.error("❌ Не удалось отправить сообщение об ошибке:", replyError);
  }
});

// === ЗАПУСК ===
console.log("🚀 Запуск TikTok Analyzer Bot...");
bot.launch();

process.once("SIGINT", () => {
  console.log("🛑 Остановка бота...");
  bot.stop("SIGINT");
});

process.once("SIGTERM", () => {
  console.log("🛑 Остановка бота...");
  bot.stop("SIGTERM");
});

console.log("✅ Бот запущен!");
