import {t} from './i18n';
import {createRoot} from 'react-dom/client';
import {Component,type ReactNode} from 'react';
import './base.css';
import './style.css';
import {App} from './App';
class ErrorBoundary extends Component<{children:ReactNode},{error:string}> {
  state={error:''};
  static getDerivedStateFromError(error:Error){return {error:error.message};}
  render(){return this.state.error?<div className="page"><h1>{t("Nie udało się otworzyć aplikacji")}</h1><p role="alert">{this.state.error}</p><button className="btn btn-primary" onClick={()=>location.reload()}>{t("Odśwież")}</button></div>:this.props.children;}
}
createRoot(document.getElementById('app')!).render(<ErrorBoundary><App/></ErrorBoundary>);
