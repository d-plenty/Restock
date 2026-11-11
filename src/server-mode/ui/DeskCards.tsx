// 0.9.6 (cards): the Cards tab on the web (desktop and the iPhone's home screen app): the phone's
// own Cards screen (ui/screens/Cards.tsx), with the cards kept in THIS BROWSER ONLY
// (server-mode/cardStore.ts), never sent to the server. Below them, the loyalty cards the phones
// chose to share, by name only (the server blanks their numbers, as before).
import { useLive } from '../../lib/useLive';
import { Icon } from '../../ui/components';
import { CardsScreen } from '../../ui/screens/Cards';
import { isHomeScreenApp, thisBrowserCards } from '../cardStore';
import { cardNames } from './settingsData';

export const WEB_CARDS_NOTE = 'Cards in the web page are kept only in this browser; they are not sent to the server.';

function SharedByPhones() {
  const names = useLive(cardNames, []);
  if (!names?.length) return null;
  return (
    <div className="card" aria-labelledby="cc-shared">
      <h2 className="cc-h2" id="cc-shared">
        <Icon name="lock" size={18} /> Loyalty cards your phones share
      </h2>
      <p className="small" style={{ margin: 0 }}>
        {names.join(', ')}. Their numbers stay on the phones. To show one here, save it to a cards file on the phone and open it in this browser.
      </p>
    </div>
  );
}

export function DeskCards({ back = false }: { back?: boolean }) {
  const store = thisBrowserCards();
  return (
    <div className="dk-phone-page">
      <CardsScreen
        store={store}
        back={back}
        intro={
          <div className="banner grey cc-kept" role="note">
            <Icon name="lock" size={18} />
            <span>
              {WEB_CARDS_NOTE} They work with no connection once this page has loaded.
              {isHomeScreenApp() ? ' On an iPhone, iOS can clear a web app’s storage when the phone is low on space, so keep a cards file somewhere safe.' : ''}
            </span>
          </div>
        }
        extra={<SharedByPhones />}
      />
    </div>
  );
}
